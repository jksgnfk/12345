/* ============================================================
 * utils/exporter.js — 单据材料一键导出
 * 把某条报销记录的图片 / 文件按材料类别整理，打包为 ZIP 文件夹。
 * 云端文件（fileID）先下载到本地，本地文件直接读取；最终用 zip.js 生成 zip。
 * ============================================================ */
const store = require('./store.js');
const { zipFiles } = require('./zip.js');
const fs = wx.getFileSystemManager();

/* 清理文件名中的非法字符（Windows / macOS 均不允许） */
function sanitize(name) {
  return (name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}
/* 从路径猜测扩展名（忽略 URL 查询串） */
function guessExt(path) {
  const m = (path || '').split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : 'bin';
}
function readBytes(path) {
  try { return fs.readFileSync(path); } catch (e) { return null; }
}
function downloadFile(fileID) {
  if (!wx.cloud) return Promise.reject(new Error('cloud not init'));
  return wx.cloud.downloadFile({ fileID }).then(r => r.tempFilePath);
}

/**
 * 导出某条记录的全部材料为 zip。
 * @param {object} rec 报销记录（含 materials）
 * @returns {Promise<string|null>} 成功返回 zip 路径；无材料返回 null
 */
function exportRecordMaterials(rec) {
  if (!rec || !rec.materials) return Promise.resolve(null);
  const entries = [];
  let idx = 0;
  const keys = Object.keys(rec.materials);

  const collect = async () => {
    for (const k of keys) {
      const list = rec.materials[k] || [];
      if (!list.length) continue;
      const matName = store.MATNAME[k] || k;
      for (const f of list) {
        idx++;
        let srcPath = null;
        if (f.fileID) {
          try { srcPath = await downloadFile(f.fileID); } catch (e) { srcPath = null; }
        }
        if (!srcPath) srcPath = f.path; // 回退：本地路径
        if (!srcPath) continue;

        let ext = (f.ext && f.ext !== 'IMG') ? f.ext.toLowerCase() : guessExt(srcPath);
        if (!ext) ext = 'bin';

        const data = readBytes(srcPath);
        if (!data || (data.byteLength === 0 && data.length === 0)) continue;
        const buffer = (data instanceof ArrayBuffer) ? data : new Uint8Array(data).buffer;
        entries.push({
          name: String(idx).padStart(2, '0') + '-' + sanitize(matName) + '.' + ext,
          buffer
        });
      }
    }
  };

  return collect().then(() => {
    if (!entries.length) return null;
    const base = '报销材料-' + sanitize(rec.reason || '单据') + '-' + rec.id;
    const zipPath = wx.env.USER_DATA_PATH + '/' + base + '.zip';
    return zipFiles(entries, zipPath).then(() => zipPath);
  });
}

module.exports = { exportRecordMaterials };
