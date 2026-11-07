/* ============================================================
 * 宸阳书院报销系统 · 网页版多端同步网关（L1）
 * 经微信云开发「HTTP 访问服务」对外提供 /sync/* 接口。
 * 口令从环境变量 SYNC_TOKEN 读取，禁止写死在前端。
 * ------------------------------------------------------------
 * 兼容两种调用方式：
 *   1) HTTP 访问服务：event.body 为字符串，返回 {statusCode, headers, body}
 *   2) 云函数 callFunction（本地调试）：直接返回业务对象
 * 数据安全：pull 只读；push 按 updatedAt 拒绝旧数据覆盖云端新数据，
 *           并保留云端 _openid，避免破坏小程序端「仅本人可写」的安全规则。
 * ============================================================ */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TOKEN = process.env.SYNC_TOKEN || '';
const ALLOW_ORIGIN = process.env.SYNC_ORIGIN || '*';
const MAX_BATCH = 100;   // 云函数端单次查询上限
const MAX_PAGES = 20;    // 单据最多 20 批 = 2000 条，防止无限循环
const MAX_FILES = 50;    // getTempFileURL 单批上限

function isHttpEvent(e) {
  return !!(e && (e.httpMethod || e.requestContext || e.path || e.headers));
}
function parseBody(e) {
  if (!e) return {};
  if (typeof e.body === 'string') {
    try { return JSON.parse(e.body || '{}'); } catch (err) { return {}; }
  }
  if (e.body && typeof e.body === 'object') return e.body;
  return e;
}
/* 动作优先取 body.action；兼容 HTTP 访问服务的各种路径字段 */
function actionOf(e, body) {
  if (body && body.action) return String(body.action);
  const rc = e && e.requestContext;
  const p = (e && (e.path || (rc && rc.path) || e.httpPath || e.url)) || '';
  return String(p).split('?')[0].split('/').filter(Boolean).pop() || '';
}
function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
function reply(e, result, status) {
  if (!isHttpEvent(e)) return result;
  return { statusCode: status || 200, headers: cors(), body: JSON.stringify(result) };
}

/* 分批取全量：云函数单次最多 100 条，skip 翻页 */
async function fetchAll(col, pages) {
  const out = [];
  for (let i = 0; i < pages; i++) {
    const r = await col.skip(i * MAX_BATCH).limit(MAX_BATCH).get().catch(() => ({ data: [] }));
    const list = (r && r.data) || [];
    out.push.apply(out, list);
    if (list.length < MAX_BATCH) break;
  }
  return out;
}

function collectFileIDs(records) {
  const ids = [], seen = {};
  (records || []).forEach(r => {
    Object.keys((r && r.materials) || {}).forEach(k => {
      ((r.materials[k]) || []).forEach(f => {
        if (f && f.fileID && !seen[f.fileID]) { seen[f.fileID] = 1; ids.push(f.fileID); }
      });
    });
  });
  return ids;
}
/* 云存储 fileID 换成临时下载链接，网页端据此取回材料本体 */
async function tempUrls(ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += MAX_FILES) {
    const r = await cloud.getTempFileURL({ fileList: ids.slice(i, i + MAX_FILES) }).catch(() => null);
    (((r && r.fileList) || [])).forEach(x => {
      if (x && x.fileID && x.tempFileURL) map[x.fileID] = x.tempFileURL;
    });
  }
  return map;
}

async function doPull() {
  const [records, announcements] = await Promise.all([
    fetchAll(db.collection('records'), MAX_PAGES),
    fetchAll(db.collection('announcements'), 5)
  ]);
  const fileUrls = await tempUrls(collectFileIDs(records));
  return { ok: true, records, announcements, fileUrls, updatedAt: Date.now() };
}

function stripMeta(x) {
  const d = Object.assign({}, x);
  delete d._id; delete d._buf; delete d._openid;
  return d;
}
/* 返回 'write' | 'skip'；云端较新时拒绝覆盖 */
async function upsert(col, id, incoming) {
  const old = await col.doc(id).get().catch(() => null);
  const oldData = old && old.data;
  if (oldData) {
    const a = Number(incoming.updatedAt || incoming.updated || 0) || 0;
    const b = Number(oldData.updatedAt || oldData.updated || 0) || 0;
    if (a && b && a < b) return 'skip';
  }
  const data = stripMeta(incoming);
  if (oldData && oldData._openid) data._openid = oldData._openid;
  await col.doc(id).set({ data });
  return 'write';
}
async function doPush(body) {
  let written = 0, skipped = 0;
  try { await db.createCollection('announcements'); } catch (e) { /* 已存在 */ }
  const recs = Array.isArray(body.records) ? body.records : [];
  for (const r of recs) {
    if (!r || !r.id) continue;
    if (await upsert(db.collection('records'), String(r.id), r) === 'skip') skipped++; else written++;
  }
  const anns = Array.isArray(body.announcements) ? body.announcements : [];
  for (const a of anns) {
    if (!a || !a._id) continue;
    if (await upsert(db.collection('announcements'), String(a._id), a) === 'skip') skipped++; else written++;
  }
  return { ok: true, written, skipped, updatedAt: Date.now() };
}

exports.main = async (event) => {
  const e = event || {};
  if (isHttpEvent(e) && (e.httpMethod === 'OPTIONS' || e.requestMethod === 'OPTIONS')) {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  const body = parseBody(e);
  if (!TOKEN) return reply(e, { ok: false, msg: '网关未配置 SYNC_TOKEN 环境变量' }, 500);
  if (body.token !== TOKEN) return reply(e, { ok: false, msg: '口令错误' }, 401);

  const action = actionOf(e, body);
  try {
    if (action === 'ping') return reply(e, { ok: true, env: cloud.getWXContext().ENV, time: Date.now() });
    if (action === 'pull') return reply(e, await doPull());
    if (action === 'push') return reply(e, await doPush(body));
    return reply(e, { ok: false, msg: '未知操作: ' + action }, 400);
  } catch (err) {
    return reply(e, { ok: false, msg: '服务端错误: ' + (err && err.message ? err.message : err) }, 500);
  }
};
