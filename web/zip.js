/* ============================================================
 * 宸阳书院报销系统 · 网页版 ZIP 工具（浏览器 / Node 通用，零依赖）
 *   buildZip   : STORE 方式打包，UTF-8 中文名（移植自小程序 utils/zip.js）
 *   unzipStore : 解析 STORE 方式 ZIP（用于导入「完整快照」）
 * 仅支持 STORE（不压缩），这正是本系统生成的格式；中文名使用
 * general purpose bit flag 0x0800 标记，Windows / macOS 均可正常解压。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CyZip = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function makeCRCTable() {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }
  var CRC_TABLE = makeCRCTable();

  function crc32(buf) {
    var b = toUint8(buf), c = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ b[i]) & 0xFF];
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* 手工 UTF-8 编码，避免依赖 TextEncoder（浏览器/Node 均可用） */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    var b = toUint8(bytes);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(b); } catch (e) { /* 降级 */ }
    }
    var s = '', i = 0;
    while (i < b.length) {
      var c = b[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xE0) s += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F));
      else if (c < 0xF0) s += String.fromCharCode(((c & 0x0F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F));
      else {
        var cp = ((c & 0x07) << 18) | ((b[i++] & 0x3F) << 12) | ((b[i++] & 0x3F) << 6) | (b[i++] & 0x3F);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return s;
  }

  function toUint8(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView && ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (Array.isArray(b)) return new Uint8Array(b);
    return new Uint8Array(0);
  }

  function textBuffer(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return utf8Bytes(s);
  }

  /* ---------- 打包 ---------- */
  function buildZip(entries) {
    var files = entries.map(function (e) { return { name: e.name, data: toUint8(e.buffer) }; });
    var nameBytes = files.map(function (f) { return utf8Bytes(f.name); });
    var crcs = files.map(function (f) { return crc32(f.data); });
    var sizes = files.map(function (f) { return f.data.length; });
    var localSize = 0, cdSize = 0, i;
    for (i = 0; i < files.length; i++) {
      localSize += 30 + nameBytes[i].length + sizes[i];
      cdSize += 46 + nameBytes[i].length;
    }
    var total = localSize + cdSize + 22;
    var buf = new Uint8Array(total);
    var dv = new DataView(buf.buffer);
    var off = 0;
    function u32(v) { dv.setUint32(off, v >>> 0, true); off += 4; }
    function u16(v) { dv.setUint16(off, v & 0xFFFF, true); off += 2; }
    function bytes(a) { buf.set(a, off); off += a.length; }
    var FLAG = 0x0800, offsets = [];
    for (i = 0; i < files.length; i++) {
      offsets.push(off);
      u32(0x04034b50); u16(20); u16(FLAG); u16(0); u16(0); u16(0);
      u32(crcs[i]); u32(sizes[i]); u32(sizes[i]); u16(nameBytes[i].length); u16(0);
      bytes(nameBytes[i]); bytes(files[i].data);
    }
    var cdStart = off;
    for (i = 0; i < files.length; i++) {
      u32(0x02014b50); u16(20); u16(20); u16(FLAG); u16(0); u16(0); u16(0);
      u32(crcs[i]); u32(sizes[i]); u32(sizes[i]); u16(nameBytes[i].length);
      u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]);
      bytes(nameBytes[i]);
    }
    u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length); u32(cdSize); u32(cdStart); u16(0);
    return buf;
  }

  /* ---------- 解包（仅 STORE） ----------
   * 返回 [{ name, data: Uint8Array }]；遇到非 STORE 条目会抛出可读错误。
   */
  function unzipStore(bytes) {
    var b = toUint8(bytes);
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var eocd = -1;
    var min = Math.max(0, b.length - 65558);
    for (var i = b.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var out = [];
    for (var n = 0; n < count; n++) {
      if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
      var method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true);
      var elen = dv.getUint16(off + 30, true);
      var clen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = utf8Decode(b.subarray(off + 46, off + 46 + nlen));
      if (method !== 0) throw new Error('该 ZIP 使用了压缩方式，仅支持本系统生成的 STORE 快照');
      if (lho + 30 > b.length || dv.getUint32(lho, true) !== 0x04034b50) throw new Error('ZIP 文件头损坏');
      var lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      var start = lho + 30 + lnlen + lelen;
      out.push({ name: name, data: b.slice(start, start + csize) });
      off += 46 + nlen + elen + clen;
    }
    return out;
  }

  return {
    buildZip: buildZip, unzipStore: unzipStore, crc32: crc32,
    toUint8: toUint8, textBuffer: textBuffer, utf8Decode: utf8Decode
  };
});
