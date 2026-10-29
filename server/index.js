/* ============================================================
 * 宸阳书院报销系统 · 云托管后端容器
 * 与小程序共用同一个云环境数据库（records 集合）。
 * 监听端口：process.env.PORT || 3000
 * 云环境：process.env.WX_CLOUD_ENV || 默认环境 ID
 *
 * 容错设计（关键）：
 *   - 云初始化失败不会让容器崩溃，保证健康检查/端口始终可用
 *   - 所有数据库操作前校验 db 是否已就绪，未就绪返回明确错误
 *
 * 安全模型（与 auditStage 云函数一致）：
 *   - 改进程 / 退回 / 删除 / 清空 等写操作需携带审核密钥
 *   - ADMIN_KEY='社畜' 拥有全部权限；AUDIT_KEY='天选打工人' 可改进程、退回
 * ============================================================ */
const express = require('express');
const cloud = require('wx-server-sdk');

const ENV = process.env.WX_CLOUD_ENV || 'cloud1-d7go7cz1ccef43aa4';
let cloudReady = true;
try {
  cloud.init({ env: ENV });
} catch (e) {
  cloudReady = false;
  console.error('[warn] wx-server-sdk init failed, DB calls will fail until env is correctly bound:', (e && e.message) || e);
}
const db = cloudReady ? cloud.database() : null;

const ADMIN_KEY = '社畜';
const AUDIT_KEY = '天选打工人';

const app = express();
app.use(express.json({ limit: '10mb' }));
// 开放 CORS，便于小程序 / 网页 / 测试工具跨域调用
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function roleOf(key) {
  if (key === ADMIN_KEY) return 'admin';
  if (key === AUDIT_KEY) return 'audit';
  return null;
}

function collectFileIDs(rec) {
  const ids = [];
  const mats = rec && rec.materials;
  if (mats) {
    Object.keys(mats).forEach(k => (mats[k] || []).forEach(f => { if (f && f.fileID) ids.push(f.fileID); }));
  }
  return ids;
}

function applyToggle(r, v) {
  r.stageLog = r.stageLog || {};
  if (r.rejected && v <= r.stage) r.rejected = false;
  else if (v > r.stage) { r.stage = v; r.stageLog[v] = Date.now(); r.rejected = false; }
  else { r.stage = v; r.rejected = false; }
}

function dbUnavailable(res) {
  return res.status(503).json({ ok: false, msg: '云数据库未就绪：请确认云托管已绑定云环境，且 WX_CLOUD_ENV 正确' });
}

/* ---------- 根路径（云托管默认健康检查兜底） ---------- */
app.get('/', (req, res) => res.json({ ok: true, service: 'reimbursement-server', cloudReady }));

/* ---------- 健康检查（云托管存活探针） ---------- */
app.get('/health', (req, res) => res.json({ ok: true, env: ENV, cloudReady, time: Date.now() }));

/* ---------- 查询记录 ---------- */
app.get('/api/records', async (req, res) => {
  if (!db) return dbUnavailable(res);
  try {
    const { openid, type } = req.query;
    let q = db.collection('records');
    if (openid) q = q.where({ _openid: openid });
    else if (type) q = q.where({ type });
    const r = await q.orderBy('createdAt', 'desc').limit(1000).get();
    res.json({ ok: true, data: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, msg: String((e && e.message) || e) });
  }
});

/* ---------- 新增记录 ---------- */
app.post('/api/records', async (req, res) => {
  if (!db) return dbUnavailable(res);
  try {
    const rec = req.body || {};
    const id = rec.id || ('R' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    const now = Date.now();
    const data = Object.assign({}, rec, {
      id,
      createdAt: rec.createdAt || now,
      updatedAt: now,
      stage: 0,
      rejected: false,
      stageLog: Object.assign({ 0: now }, rec.stageLog || {})
    });
    // 记录归属：优先使用调用方传入的 openid（小程序登录态），便于"我的单据"过滤
    if (rec.openid) data._openid = rec.openid;
    if (rec.owner) data.owner = rec.owner;
    delete data.id; // doc id 用 .doc(id)
    await db.collection('records').doc(id).set({ data });
    res.json({ ok: true, record: data });
  } catch (e) {
    res.status(500).json({ ok: false, msg: String((e && e.message) || e) });
  }
});

/* ---------- 审核写操作（服务端密钥校验） ---------- */
app.post('/api/audit', async (req, res) => {
  if (!db) return dbUnavailable(res);
  try {
    const { id, action, v, key } = req.body || {};
    const role = roleOf(key);
    if (!role) return res.json({ ok: false, msg: '密钥错误' });

    if (action === 'toggle' || action === 'reject') {
      if (!id) return res.json({ ok: false, msg: '缺少记录ID' });
      const r0 = await db.collection('records').doc(id).get().catch(() => null);
      const r = r0 && r0.data;
      if (!r) return res.json({ ok: false, msg: '记录不存在' });
      if (action === 'reject') { r.rejected = true; r.stage = 0; }
      else applyToggle(r, Number(v) || 0);
      r.updatedAt = Date.now();
      const data = Object.assign({}, r);
      delete data._id;
      await db.collection('records').doc(id).set({ data });
      return res.json({ ok: true, record: r, role });
    }

    if (action === 'delete') {
      if (role !== 'admin') return res.json({ ok: false, msg: '仅管理员可删除' });
      if (!id) return res.json({ ok: false, msg: '缺少记录ID' });
      const r0 = await db.collection('records').doc(id).get().catch(() => null);
      const r = r0 && r0.data;
      const fids = collectFileIDs(r);
      await db.collection('records').doc(id).remove().catch(() => {});
      if (fids.length) await cloud.deleteFile({ fileList: fids }).catch(() => {});
      return res.json({ ok: true });
    }

    if (action === 'clearAll') {
      if (role !== 'admin') return res.json({ ok: false, msg: '仅管理员可清空' });
      const all = await db.collection('records').limit(1000).get().catch(() => ({ data: [] }));
      const list = all.data || [];
      for (const r of list) {
        const fids = collectFileIDs(r);
        await db.collection('records').doc(r._id).remove().catch(() => {});
        if (fids.length) await cloud.deleteFile({ fileList: fids }).catch(() => {});
      }
      return res.json({ ok: true, count: list.length });
    }

    return res.json({ ok: false, msg: '未知操作' });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '服务端错误: ' + String((e && e.message) || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`[reimbursement-server] listening on ${PORT}, env=${ENV}, cloudReady=${cloudReady}`));
