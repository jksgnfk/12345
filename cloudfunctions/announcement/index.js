/* ============================================================
 * 宸阳书院报销系统 · 公告栏写云函数（服务端最高管理密钥校验）
 * 作用：把"发布 / 修改 / 删除"等写操作收敛到服务端，
 *       只有持正确最高管理密钥(ADMIN_KEY)的请求才被允许，
 *       普通用户无法发布、修改或删除公告（只能读取 list）。
 * 配合 announcements 集合使用；list 为公开只读，写操作受密钥保护。
 * ============================================================ */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ADMIN_KEY = '社畜';
const COLLECTION = 'announcements';

/* 幂等：确保集合存在（首写时自动创建，已存在则忽略报错）。
   这样无需在云控制台手动新建集合即可直接使用公告栏。 */
async function ensureCollection() {
  try { await db.createCollection(COLLECTION); } catch (e) { /* 已存在或无需处理 */ }
}

exports.main = async (event) => {
  const { action, key, id, title, content, pinned } = event || {};
  const isAdmin = (key === ADMIN_KEY);
  const col = db.collection(COLLECTION);

  try {
    await ensureCollection();
    /* 公开只读：所有用户均可拉取公告列表（置顶优先、再按创建时间倒序） */
    if (action === 'list') {
      const res = await col
        .orderBy('pinned', 'desc')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get()
        .catch(() => ({ data: [] }));
      return { ok: true, list: res.data || [] };
    }

    /* 以下均为写操作，必须先通过最高管理密钥校验 */
    if (!isAdmin) return { ok: false, msg: '仅最高管理可执行该操作' };

    if (action === 'add') {
      if (!title || !title.trim()) return { ok: false, msg: '标题不能为空' };
      const now = Date.now();
      const doc = {
        title: title.trim(),
        content: (content || '').trim(),
        pinned: !!pinned,
        createdAt: now,
        updatedAt: now
      };
      const r = await col.add({ data: doc });
      return { ok: true, id: r._id, doc: Object.assign({ _id: r._id }, doc) };
    }

    if (action === 'update') {
      if (!id) return { ok: false, msg: '缺少公告ID' };
      const patch = { updatedAt: Date.now() };
      if (title !== undefined) patch.title = (title || '').trim();
      if (content !== undefined) patch.content = (content || '').trim();
      if (pinned !== undefined) patch.pinned = !!pinned;
      await col.doc(id).update({ data: patch }).catch(() => {});
      return { ok: true };
    }

    if (action === 'remove') {
      if (!id) return { ok: false, msg: '缺少公告ID' };
      await col.doc(id).remove().catch(() => {});
      return { ok: true };
    }

    return { ok: false, msg: '未知操作' };
  } catch (e) {
    return { ok: false, msg: '服务端错误: ' + (e && e.message ? e.message : e) };
  }
};
