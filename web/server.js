/* ============================================================
 * 宸阳书院报销系统 · 网页版在线共享服务
 * 零依赖 Node HTTP 服务 = 静态站点托管 + /api 共享数据接口
 * 监听 process.env.PORT 并绑定 0.0.0.0（应用发布要求）。
 *
 * 数据文件：data/state.json（原子写入）
 * 同步语义：服务端为唯一数据源，按 id + updatedAt 做记录级合并，
 *          删除通过 tombs 墓碑传播；每次写入 rev+1，客户端轮询 rev。
 * 数据：state.json 存单据/公告元数据；data/files/ 存材料原始二进制，供多端按需取回。
 * 不同步的内容：身份登记、角色、密钥、未读时间戳（始终只在各设备本机）。
 * ============================================================ */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var urlLib = require('url');

var ROOT = __dirname;
var DATA_DIR = path.join(ROOT, 'data');
var STATE_FILE = path.join(DATA_DIR, 'state.json');
var FILES_DIR = path.join(DATA_DIR, 'files');   // 材料文件本体（跨设备按需取回）
var PORT = Number(process.env.PORT) || 3000;
var MAX_BODY = 20 * 1024 * 1024;
var MAX_FILE = 8 * 1024 * 1024;                 // 单份材料原始字节上限
var TOMB_TTL = 120 * 24 * 3600 * 1000;
var KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function stamp(r) { return num(r && (r.updatedAt || r.createdAt)); }

function emptyState() {
  return { rev: 0, records: [], announcements: [], tombs: {}, updatedAt: 0 };
}

function readState() {
  try {
    var j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      rev: num(j.rev),
      records: Array.isArray(j.records) ? j.records : [],
      announcements: Array.isArray(j.announcements) ? j.announcements : [],
      tombs: (j.tombs && typeof j.tombs === 'object' && !Array.isArray(j.tombs)) ? j.tombs : {},
      updatedAt: num(j.updatedAt)
    };
  } catch (e) { return emptyState(); }
}

function writeState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  var tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/* 记录级合并：以服务端为基准，逐条比较 updatedAt；墓碑优先于记录。 */
function mergeList(serverList, incomingList, key, tombs) {
  var map = {};
  serverList.forEach(function (r) { if (r && r[key] != null) map[String(r[key])] = r; });
  (incomingList || []).forEach(function (r) {
    if (!r || r[key] == null) return;
    var id = String(r[key]);
    if (num(tombs[id]) >= stamp(r)) return;          // 已被删除
    var cur = map[id];
    if (!cur || stamp(r) >= stamp(cur)) map[id] = r; // 新的覆盖旧的
  });
  Object.keys(map).forEach(function (id) {
    if (num(tombs[id]) >= stamp(map[id])) delete map[id];
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

function mergeState(server, body) {
  var tombs = {}, cut = Date.now() - TOMB_TTL;
  Object.keys(server.tombs).forEach(function (k) { if (num(server.tombs[k]) >= cut) tombs[k] = num(server.tombs[k]); });
  Object.keys(body.tombs || {}).forEach(function (k) {
    var t = num(body.tombs[k]);
    if (t >= cut && t > num(tombs[k])) tombs[k] = t;
  });
  return {
    rev: server.rev + 1,
    records: mergeList(server.records, body.records, 'id', tombs),
    announcements: mergeList(server.announcements, body.announcements, '_id', tombs),
    tombs: tombs,
    updatedAt: Date.now()
  };
}

function json(res, code, obj) {
  var buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(buf);
}

function text(res, code, msg) {
  var buf = Buffer.from(msg, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req, cb) {
  var chunks = [], size = 0, tooBig = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) tooBig = true; else chunks.push(c);
  });
  req.on('end', function () {
    if (tooBig) return cb(new Error('请求体过大（上限 20 MB）'));
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(new Error('JSON 解析失败')); }
  });
  req.on('error', function (e) { cb(e); });
}

function serveStatic(pathname, res) {
  var rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  var norm = rel.replace(/\\/g, '/');
  if (/^data\//.test(norm) || /(^|\/)\./.test(norm) || norm.indexOf('node_modules') >= 0) {
    return text(res, 403, '禁止访问');
  }
  var file = path.resolve(ROOT, rel);
  if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) return text(res, 403, '禁止访问');
  fs.readFile(file, function (err, buf) {
    if (err) return text(res, 404, '文件不存在：' + pathname);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

var server = http.createServer(function (req, res) {
  var pathname;
  try { pathname = decodeURIComponent(urlLib.parse(req.url).pathname || '/'); }
  catch (e) { pathname = '/'; }

  if (pathname.indexOf('/api/') === 0) {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (pathname === '/api/ping') {
      return json(res, 200, { ok: true, mode: 'shared', rev: readState().rev, time: Date.now() });
    }
    /* 材料文件本体：按 key 存取原始二进制。文件名固定 <key>.bin，
     * 真实 MIME / 扩展名由前端按文件头判断，避免依赖上传方声明。 */
    if (pathname === '/api/file' && req.method === 'GET') {
      var fkey = '';
      try { fkey = (urlLib.parse(req.url, true).query.key || ''); } catch (e) { fkey = ''; }
      if (!KEY_RE.test(fkey)) return json(res, 400, { ok: false, msg: '非法文件 key' });
      return fs.readFile(path.join(FILES_DIR, fkey + '.bin'), function (err, buf) {
        if (err) return json(res, 404, { ok: false, msg: '文件不存在' });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(buf);
      });
    }
    if (pathname === '/api/file' && req.method === 'POST') {
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, msg: err.message });
        var key = body && body.key, data = body && body.data;
        if (!KEY_RE.test(key || '')) return json(res, 400, { ok: false, msg: '非法文件 key' });
        var raw;
        try { raw = Buffer.from(String(data || ''), 'base64'); }
        catch (e) { return json(res, 400, { ok: false, msg: '文件数据解码失败' }); }
        if (!raw.length || raw.length > MAX_FILE) {
          return json(res, 400, { ok: false, msg: '文件为空或超过 8 MB 上限' });
        }
        try { fs.mkdirSync(FILES_DIR, { recursive: true }); }
        catch (e) { return json(res, 500, { ok: false, msg: '创建文件目录失败' }); }
        var target = path.join(FILES_DIR, key + '.bin'), tmp = target + '.tmp';
        return fs.writeFile(tmp, raw, function (we) {
          if (we) return json(res, 500, { ok: false, msg: '文件写入失败' });
          fs.rename(tmp, target, function (re) {
            if (re) return json(res, 500, { ok: false, msg: '文件落盘失败' });
            json(res, 200, { ok: true, key: key, size: raw.length });
          });
        });
      });
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      var s = readState();
      return json(res, 200, { ok: true, rev: s.rev, records: s.records, announcements: s.announcements, tombs: s.tombs, updatedAt: s.updatedAt });
    }
    if (pathname === '/api/state' && req.method === 'POST') {
      return readBody(req, function (err, body) {
        if (err) return json(res, 400, { ok: false, msg: err.message });
        if (!body || !Array.isArray(body.records) || !Array.isArray(body.announcements)) {
          return json(res, 400, { ok: false, msg: '缺少 records / announcements 数组' });
        }
        var merged = mergeState(readState(), body);
        try { writeState(merged); }
        catch (e2) { return json(res, 500, { ok: false, msg: '服务端写入失败：' + e2.message }); }
        return json(res, 200, {
          ok: true, rev: merged.rev, records: merged.records,
          announcements: merged.announcements, tombs: merged.tombs, updatedAt: merged.updatedAt
        });
      });
    }
    return json(res, 404, { ok: false, msg: '未知接口' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method Not Allowed');
  serveStatic(pathname, res);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('[cy-web] shared workspace listening on 0.0.0.0:' + PORT);
});
