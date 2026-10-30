/* ============================================================
 * 宸阳书院报销系统 · 公告栏数据层
 * 云端模式：list(只读) / add / update / remove 全部经 announcement 云函数；
 *           写操作在服务端校验最高管理密钥，普通用户无法篡改。
 * 本地兜底模式：公告存于本机 wx.Storage，写操作受 store.isAdmin() 限制。
 * 未读提醒：以"最后阅读时间戳"为基准，任何 createdAt/updatedAt 更新的公告即视为未读。
 * ============================================================ */
const cfg = require('./config.js');
const store = require('./store.js');

const CLOUD_ENABLED = !!(cfg && cfg.ENV_ID && cfg.ENV_ID.indexOf('REPLACE') < 0);
const K_LIST = 'cy_announcements';
const K_LASTREAD = 'cy_announce_lastread';
const K_KEY = 'cy_announce_key';
const COLLECTION = 'announcements';

let _list = null;

function genId() {
  return 'A' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/* 置顶优先，其次按创建时间倒序 */
function sortList(arr) {
  return (arr || []).slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function cloudCall(action, data) {
  return wx.cloud.callFunction({ name: 'announcement', data: Object.assign({ action }, data) })
    .then(r => (r && r.result) || { ok: false, msg: '调用失败' });
}

/* ---------- 读取 ---------- */
function refresh() {
  if (CLOUD_ENABLED && wx.cloud) {
    return cloudCall('list').then(res => {
      if (res.ok) { _list = sortList(res.list || []); wx.setStorageSync(K_LIST, _list); }
      else { _list = wx.getStorageSync(K_LIST) || []; }
      return _list;
    }).catch(() => {
      _list = wx.getStorageSync(K_LIST) || [];
      return _list;
    });
  }
  _list = wx.getStorageSync(K_LIST) || [];
  return Promise.resolve(_list);
}
function init() { return refresh(); }
function getList() { return _list || []; }

/* ---------- 未读 ---------- */
function getLastRead() { const v = wx.getStorageSync(K_LASTREAD); return v ? Number(v) : 0; }
function setLastRead(ts) { wx.setStorageSync(K_LASTREAD, ts || Date.now()); }
function getUnread() {
  const lr = getLastRead();
  return getList().filter(a => (a.updatedAt || a.createdAt || 0) > lr);
}
function unreadCount() { return getUnread().length; }

/* ---------- 写操作 ---------- */
/* 本地模式下：最高管理(角色) 或 正确的管理员密钥 均可写 */
function localAdminOK(key) {
  if (store.isAdmin()) return true;
  if (key && key.trim() === store.ADMIN_KEY) return true;
  return false;
}

function add(data, key) {
  if (CLOUD_ENABLED && wx.cloud) {
    return cloudCall('add', { key: key || '', title: data.title, content: data.content, pinned: data.pinned })
      .then(res => { if (res.ok) refresh(); return res; });
  }
  if (!localAdminOK(key)) return Promise.resolve({ ok: false, msg: '仅最高管理可发布' });
  const now = Date.now();
  const doc = {
    _id: genId(),
    title: (data.title || '').trim(),
    content: (data.content || '').trim(),
    pinned: !!data.pinned,
    createdAt: now, updatedAt: now
  };
  const arr = wx.getStorageSync(K_LIST) || [];
  arr.push(doc);
  wx.setStorageSync(K_LIST, arr);
  _list = sortList(arr);
  return Promise.resolve({ ok: true });
}

function update(id, patch, key) {
  if (CLOUD_ENABLED && wx.cloud) {
    return cloudCall('update', { key: key || '', id, title: patch.title, content: patch.content, pinned: patch.pinned })
      .then(res => { if (res.ok) refresh(); return res; });
  }
  if (!localAdminOK(key)) return Promise.resolve({ ok: false, msg: '仅最高管理可修改' });
  const arr = wx.getStorageSync(K_LIST) || [];
  const i = arr.findIndex(a => a._id === id);
  if (i < 0) return Promise.resolve({ ok: false, msg: '公告不存在' });
  if (patch.title !== undefined) arr[i].title = (patch.title || '').trim();
  if (patch.content !== undefined) arr[i].content = (patch.content || '').trim();
  if (patch.pinned !== undefined) arr[i].pinned = !!patch.pinned;
  arr[i].updatedAt = Date.now();
  wx.setStorageSync(K_LIST, arr);
  _list = sortList(arr);
  return Promise.resolve({ ok: true });
}

function remove(id, key) {
  if (CLOUD_ENABLED && wx.cloud) {
    return cloudCall('remove', { key: key || '', id })
      .then(res => { if (res.ok) refresh(); return res; });
  }
  if (!localAdminOK(key)) return Promise.resolve({ ok: false, msg: '仅最高管理可删除' });
  let arr = wx.getStorageSync(K_LIST) || [];
  arr = arr.filter(a => a._id !== id);
  wx.setStorageSync(K_LIST, arr);
  _list = sortList(arr);
  return Promise.resolve({ ok: true });
}

/* ---------- 管理密钥缓存（云端写操作需传给云函数校验） ---------- */
function getKey() { return wx.getStorageSync(K_KEY) || ''; }
function setKey(k) { wx.setStorageSync(K_KEY, k || ''); }
function clearKey() { wx.removeStorageSync(K_KEY); }

module.exports = {
  CLOUD_ENABLED, COLLECTION,
  init, refresh, getList,
  getLastRead, setLastRead, getUnread, unreadCount,
  add, update, remove, getKey, setKey, clearKey
};
