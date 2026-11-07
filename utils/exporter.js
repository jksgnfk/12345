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
/* 按文件头判定真实扩展名，避免图片被误标为 .bin/.txt 而无法打开 */
function sniffExt(u8) {
  const n = u8.length;
  if (n >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  if (n >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpg';
  if (n >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'gif';
  if (n >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  if (n >= 2 && u8[0] === 0x42 && u8[1] === 0x4D) return 'bmp';
  if (n >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
  return null;
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
      const folder = sanitize(matName) || '材料';   // 每个板块一个同名子文件夹
      entries.push({ name: folder + '/', buffer: new ArrayBuffer(0) }); // 显式目录条目
      let local = 0;
      for (const f of list) {
        idx++; local++;
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
        const u8 = (data instanceof ArrayBuffer) ? new Uint8Array(data) : new Uint8Array(data);
        const real = sniffExt(u8);
        if (real) ext = real;   // 以真实文件头为准，保证图片可直接打开
        const buffer = (data instanceof ArrayBuffer) ? data : new Uint8Array(data).buffer;
        const raw = sanitize(f.name || matName)
          .replace(/\.(png|jpe?g|gif|webp|bmp|pdf|txt|csv|docx?|xlsx?|zip|bin)$/i, '') || '材料';
        entries.push({
          name: folder + '/' + String(local).padStart(2, '0') + '-' + raw + '.' + ext,
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
