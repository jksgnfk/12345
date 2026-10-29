/* ============================================================
 * 宸阳书院报销系统 · 数据存储与配置中心
 * 云开发版：云端数据库(records) + 云存储(uploads) 为主，
 * 未配置云环境时自动回退到本机 wx.Storage + 本地文件。
 * 读取走内存缓存（同步），写入乐观更新缓存并异步持久化。
 * ============================================================ */
const cfg = require('./config.js');
const api = require('./api.js');
const fs = wx.getFileSystemManager();
const UPLOAD_DIR = `${wx.env.USER_DATA_PATH}/uploads`;
const K_USER = 'cy_user';
const K_RECORDS = 'cy_records';
const K_AUDIT = 'cy_audit_role';
const K_FINAL = 'cy_final_auth';
const K_AUDIT_KEY = 'cy_audit_key';

const CLOUD_ENABLED = !!(cfg && cfg.ENV_ID && cfg.ENV_ID.indexOf('REPLACE') < 0);

/* ---------- 进程节点 ---------- */
const STAGES = [
  { k: 0, name: '已提交' },
  { k: 1, name: '审核中' },
  { k: 2, name: '老师已签字' },
  { k: 3, name: '提交至计财处' },
  { k: 4, name: '项目已完成' }
];

/* ---------- 材料名 ---------- */
const MATNAME = {
  invoice: '发票',
  plan: '策划案（附预算表）',
  pay: '支付截图',
  purchase: '商品购买截图',
  proof: '材料证明截图',
  claim: '领用清单',
  other: '其他（备用）'
};

function mk(key, required, multiple) {
  return { key, required, multiple, name: MATNAME[key] };
}
/* 服装采购附带的领用清单（开启后必传） */
const CLOTHING_MAT = mk('claim', true, false);

/* 各报销类型对应的材料窗口（全部列出：必交 + 选交；末尾统一追加“其他”备用） */
const TYPE_MATERIALS = {
  '活动': [mk('invoice', true, true), mk('plan', true, false), mk('pay', true, true), mk('purchase', true, true)],
  '采购': [mk('invoice', true, true), mk('pay', true, true), mk('purchase', true, true)],
  '差旅': [mk('invoice', true, true), mk('pay', true, true), mk('proof', false, true)],
  '培训': [mk('invoice', true, true), mk('plan', false, false), mk('pay', true, true)],
  '其他': [mk('invoice', true, true), mk('pay', false, true)]
};
const OTHER_MAT = mk('other', false, true);

/* 付款方式 */
const PAY_METHODS = ['学生付款', '老师工资卡付款', '老师公务卡', '老师对公卡付款', '学校对公账户付款'];

/* 当前类型 + 服装开关 → 实际材料清单 */
function getMaterials(type, clothing) {
  const list = (TYPE_MATERIALS[type] || TYPE_MATERIALS['其他']).slice();
  if (clothing) list.push(CLOTHING_MAT);
  list.push(OTHER_MAT);
  return list;
}

/* ---------- 工具 ---------- */
function genId() {
  return 'R' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function fmtMoney(n) {
  n = Number(n) || 0;
  return '¥' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ---------- 云端数据库 ---------- */
let _db = null;
function db() { if (!_db && CLOUD_ENABLED && wx.cloud) _db = wx.cloud.database(); return _db; }
function coll() { return db().collection('records'); }
function cloudDelete(fileID) {
  if (CLOUD_ENABLED && wx.cloud && fileID) {
    wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
  }
}

/* ---------- 记录缓存（内存，同步读取） ---------- */
let _records = null; // null=尚未加载；[]=已加载为空
function _loadSource() {
  if (CLOUD_ENABLED && db()) {
    return coll().orderBy('createdAt', 'desc').limit(1000).get()
      .then(r => (r.data || []))
      .catch(() => wx.getStorageSync(K_RECORDS) || []);
  }
  return Promise.resolve(wx.getStorageSync(K_RECORDS) || []);
}
function init() { return _loadSource().then(d => { _records = d; }); }
function refresh() { return _loadSource().then(d => { _records = d; return d; }); }

function getRecords() { return _records || []; }
function getRecord(id) { return (_records || []).find(r => r.id === id) || null; }

function _persistLocal() { wx.setStorageSync(K_RECORDS, _records || []); }
function _saveOne(rec) {
  if (!_records) _records = [];
  const i = _records.findIndex(r => r.id === rec.id);
  if (i >= 0) _records[i] = rec; else _records.push(rec);
  if (CLOUD_ENABLED && db()) {
    return coll().doc(rec.id).set({ data: rec })
      .then(() => rec)
      .catch(e => { console.error('cloud save fail, fallback to local', e); _persistLocal(); return rec; });
  }
  _persistLocal();
  return Promise.resolve(rec);
}
function saveRecord(rec) { return _saveOne(rec); }

function localDelete(id) {
  const rec = getRecord(id);
  if (rec) {
    Object.keys(rec.materials || {}).forEach(k => {
      (rec.materials[k] || []).forEach(f => { if (f.fileID) cloudDelete(f.fileID); else removeFile(f.path); });
    });
  }
  _records = (_records || []).filter(r => r.id !== id);
  if (CLOUD_ENABLED && db()) return coll().doc(id).remove().catch(e => { console.error(e); });
  _persistLocal();
  return Promise.resolve();
}
function deleteRecord(id) {
  if (CLOUD_ENABLED && wx.cloud) {
    return _callAudit('delete', id).then(res => {
      if (res.ok) { _records = (_records || []).filter(r => r.id !== id); return; }
      return localDelete(id);
    }).catch(() => localDelete(id));
  }
  return localDelete(id);
}

/* ---------- 审核流转（云端走 auditStage 云函数，服务端校验密钥） ---------- */
function mergeRecord(rec) {
  if (!rec) return;
  if (!_records) _records = [];
  const i = _records.findIndex(x => x.id === rec.id);
  if (i >= 0) _records[i] = rec; else _records.push(rec);
}
function _callAudit(action, id, v) {
  return api.callAudit(action, id, v, getAuditKey());
}
function localToggle(rec, v) {
  rec.stageLog = rec.stageLog || {};
  if (rec.rejected && v <= rec.stage) rec.rejected = false;
  else if (v > rec.stage) { rec.stage = v; rec.stageLog[v] = Date.now(); rec.rejected = false; }
  else { rec.stage = v; rec.rejected = false; }
  rec.updatedAt = Date.now();
  return _saveOne(rec);
}
function toggleStage(rec, v) {
  if (CLOUD_ENABLED && wx.cloud) {
    return _callAudit('toggle', rec.id, v).then(res => {
      if (res.ok) { mergeRecord(res.record); return res.record; }
      return localToggle(rec, v);
    }).catch(() => localToggle(rec, v));
  }
  return localToggle(rec, v);
}
function localReject(rec) {
  rec.rejected = true; rec.stage = 0; rec.updatedAt = Date.now();
  return _saveOne(rec);
}
function rejectRecord(rec) {
  if (CLOUD_ENABLED && wx.cloud) {
    return _callAudit('reject', rec.id).then(res => {
      if (res.ok) { mergeRecord(res.record); return res.record; }
      return localReject(rec);
    }).catch(() => localReject(rec));
  }
  return localReject(rec);
}

/* ---------- 统计 ---------- */
function stageLabel(rec) {
  if (rec.rejected) return '已退回';
  return (STAGES[rec.stage] || STAGES[0]).name;
}
function stats() {
  const list = getRecords();
  const s = { total: list.length, audit: 0, signed: 0, caiwu: 0, done: 0, amount: 0 };
  list.forEach(r => {
    if (!r.rejected) {
      if (r.stage >= 1) s.audit++;
      if (r.stage >= 2) s.signed++;
      if (r.stage >= 3) s.caiwu++;
      if (r.stage >= 4) s.done++;
      s.amount += (Number(r.total) || 0);
    }
  });
  return s;
}

/* ---------- 文件持久化 ---------- */
function ensureDir() {
  try { fs.accessSync(UPLOAD_DIR); }
  catch (e) { try { fs.mkdirSync(UPLOAD_DIR, true); } catch (e2) {} }
}
function removeFile(path) {
  if (!path) return;
  try { fs.unlinkSync(path); } catch (e) {}
}
/* 上传文件：云端返回 fileID；本地回退返回本地路径。 */
function uploadFile(tempPath, name) {
  if (CLOUD_ENABLED && wx.cloud) {
    const ext = (name || tempPath || 'file').split('.').pop() || 'file';
    const cloudPath = `uploads/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: tempPath })
      .then(r => ({ ok: true, fileID: r.fileID, path: r.fileID }))
      .catch(e => { console.error('upload fail', e); return { ok: false, path: tempPath }; });
  }
  ensureDir();
  const ext = (name || tempPath || 'file').split('.').pop() || 'file';
  const dest = `${UPLOAD_DIR}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
  try { fs.saveFileSync(tempPath, dest); return Promise.resolve({ ok: true, path: dest }); }
  catch (e) { console.error('saveFile fail', e); return Promise.resolve({ ok: false, path: tempPath }); }
}

/* ---------- 导出 / 导入 / 清空 ---------- */
function exportJSON() { return JSON.stringify(getRecords()); }
function importJSON(str) {
  let arr;
  try { arr = JSON.parse(str); } catch (e) { return Promise.reject(new Error('格式错误')); }
  if (!Array.isArray(arr)) return Promise.reject(new Error('格式错误'));
  _records = arr;
  if (CLOUD_ENABLED && db()) {
    return Promise.all(arr.map(r => coll().doc(r.id).set({ data: r }).catch(() => {})));
  }
  _persistLocal();
  return Promise.resolve();
}
function localClear() {
  const list = getRecords();
  list.forEach(r => {
    Object.keys(r.materials || {}).forEach(k => {
      (r.materials[k] || []).forEach(f => { if (f.fileID) cloudDelete(f.fileID); else removeFile(f.path); });
    });
  });
  _records = [];
  if (CLOUD_ENABLED && db()) return Promise.all(list.map(r => coll().doc(r.id).remove().catch(() => {})));
  _persistLocal();
  return Promise.resolve();
}
function clearAll() {
  if (CLOUD_ENABLED && wx.cloud) {
    return _callAudit('clearAll').then(res => {
      if (res.ok) { _records = []; return; }
      return localClear();
    }).catch(() => localClear());
  }
  return localClear();
}

/* ---------- 用户 / 权限（本机会话） ---------- */
function getUser() { return wx.getStorageSync(K_USER) || null; }
function setUser(u) { wx.setStorageSync(K_USER, u); }
function logout() { wx.removeStorageSync(K_USER); }

function getAuditRole() { return wx.getStorageSync(K_AUDIT) || null; }
function setAuditRole(r) { wx.setStorageSync(K_AUDIT, r); }
function clearAuditRole() { wx.removeStorageSync(K_AUDIT); }
const ADMIN_KEY = '社畜';
const AUDIT_KEY = '天选打工人';
function verifyKey(key) {
  if (key === ADMIN_KEY) return 'admin';
  if (key === AUDIT_KEY) return 'audit';
  return null;
}
function getFinalAuth() { return wx.getStorageSync(K_FINAL) || null; }
function setFinalAuth(r) { wx.setStorageSync(K_FINAL, r); }
function clearFinalAuth() { wx.removeStorageSync(K_FINAL); }
function verifyFinalKey(key) {
  return (key || '').trim() === ADMIN_KEY ? 'admin' : null;
}
function getAuditKey() { return wx.getStorageSync(K_AUDIT_KEY) || ''; }
function setAuditKey(k) { wx.setStorageSync(K_AUDIT_KEY, k || ''); }
function clearAuditKey() { wx.removeStorageSync(K_AUDIT_KEY); }

module.exports = {
  CLOUD_ENABLED,
  STAGES, MATNAME, TYPE_MATERIALS, OTHER_MAT, CLOTHING_MAT, PAY_METHODS,
  getMaterials,
  genId, fmtMoney,
  init, refresh, getRecords, getRecord, saveRecord, deleteRecord,
  toggleStage, rejectRecord, stageLabel, stats,
  ensureDir, removeFile, uploadFile,
  exportJSON, importJSON, clearAll,
  getUser, setUser, logout,
  getAuditRole, setAuditRole, clearAuditRole, verifyKey, ADMIN_KEY, AUDIT_KEY,
  getFinalAuth, setFinalAuth, clearFinalAuth, verifyFinalKey,
  getAuditKey, setAuditKey, clearAuditKey
};
