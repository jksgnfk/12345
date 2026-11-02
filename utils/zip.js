/* ============================================================
 * utils/zip.js — 极简 ZIP 打包器（STORE 方式，无压缩）
 * 纯 JS 实现，无需任何第三方依赖，离线可用。
 * 支持 UTF-8 文件名（设置通用位标记 0x0800），中文文件名可正常解压。
 * 用法：zipFiles([{ name: 'a.jpg', buffer: ArrayBuffer }, ...], zipPath)
 * ============================================================ */
function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCRCTable();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* UTF-8 编码（不依赖 Buffer / TextEncoder，兼容小程序环境） */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  return new Uint8Array(out);
}

function toUint8(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  return new Uint8Array(buffer);
}

/**
 * 将多个文件打包为 ZIP（STORE，无压缩）。
 * @param {Array<{name:string, buffer:ArrayBuffer|Uint8Array}>} entries
 * @param {string} zipPath 输出路径（如 wx.env.USER_DATA_PATH/xxx.zip）
 * @returns {Promise<string>} 输出路径
 */
function zipFiles(entries, zipPath) {
  const files = entries.map(e => ({ name: e.name, data: toUint8(e.buffer) }));
  const nameBytes = files.map(f => utf8Bytes(f.name));
  const crcs = files.map(f => crc32(f.data));
  const sizes = files.map(f => f.data.length);

  let localSize = 0;
  for (let i = 0; i < files.length; i++) localSize += 30 + nameBytes[i].length + sizes[i];
  let cdSize = 0;
  for (let i = 0; i < files.length; i++) cdSize += 46 + nameBytes[i].length;
  const total = localSize + cdSize + 22;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let off = 0;
  const u32 = (v) => { dv.setUint32(off, v >>> 0, true); off += 4; };
  const u16 = (v) => { dv.setUint16(off, v & 0xFFFF, true); off += 2; };
  const bytes = (arr) => { buf.set(arr, off); off += arr.length; };

  const FLAG_UTF8 = 0x0800;
  const offsets = [];

  for (let i = 0; i < files.length; i++) {
    offsets.push(off);
    u32(0x04034b50);          // 本地文件头签名
    u16(20);                  // 所需版本
    u16(FLAG_UTF8);           // 通用位标记（UTF-8 文件名）
    u16(0);                   // 压缩方式：0=STORE
    u16(0);                   // 修改时间
    u16(0);                   // 修改日期
    u32(crcs[i]);             // CRC32
    u32(sizes[i]);            // 压缩后大小
    u32(sizes[i]);            // 未压缩大小
    u16(nameBytes[i].length); // 文件名长度
    u16(0);                   // 扩展字段长度
    bytes(nameBytes[i]);
    bytes(files[i].data);
  }

  const cdStart = off;
  for (let i = 0; i < files.length; i++) {
    u32(0x02014b50);          // 中央目录头签名
    u16(20);                  // 版本（由）
    u16(20);                  // 版本（解）
    u16(FLAG_UTF8);
    u16(0);                   // 压缩方式
    u16(0);                   // 修改时间
    u16(0);                   // 修改日期
    u32(crcs[i]);
    u32(sizes[i]);
    u32(sizes[i]);
    u16(nameBytes[i].length);
    u16(0);                   // 扩展字段长度
    u16(0);                   // 注释长度
    u16(0);                   // 磁盘起始号
    u16(0);                   // 内部属性
    u32(0);                   // 外部属性
    u32(offsets[i]);          // 本地头偏移
    bytes(nameBytes[i]);
  }

  u32(0x06054b50);            // 中央目录结束签名
  u16(0);
  u16(0);
  u16(files.length);
  u16(files.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);

  const fs = wx.getFileSystemManager();
  fs.writeFileSync(zipPath, buf.buffer);
  return Promise.resolve(zipPath);
}

module.exports = { zipFiles };
