/* ============================================================
 * 宸阳书院报销系统 · 审核写云函数（服务端密钥校验）
 * 作用：把"改进程 / 退回 / 删除 / 清空"等写操作收敛到服务端，
 *       只有持正确审核密钥的请求才被允许，普通提交用户无法篡改审核状态。
 * 配合 records 集合安全规则 { "read": true, "write": "doc._openid == auth.openid" }
 * 使用：客户端无法直写他人单据，唯一改 stage 的通道就是本云函数。
 * ============================================================ */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ADMIN_KEY = '社畜';
const AUDIT_KEY = '天选打工人';

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
  if (r.rejected && v <= r.stage) { r.rejected = false; r.rejectReason = ''; r.rejectAt = 0; r.rejectBy = ''; }
  else if (v > r.stage) { r.stage = v; r.stageLog[v] = Date.now(); r.rejected = false; r.rejectReason = ''; r.rejectAt = 0; r.rejectBy = ''; }
  else { r.stage = v; r.rejected = false; r.rejectReason = ''; r.rejectAt = 0; r.rejectBy = ''; }
}

exports.main = async (event) => {
  const { id, action, v, key } = event || {};
  const role = roleOf(key);
  if (!role) return { ok: false, msg: '密钥错误' };

  try {
    if (action === 'toggle' || action === 'reject') {
      if (!id) return { ok: false, msg: '缺少记录ID' };
      const res = await db.collection('records').doc(id).get().catch(() => null);
      const r = res && res.data;
      if (!r) return { ok: false, msg: '记录不存在' };
      if (action === 'reject') {
        const info = (v && typeof v === 'object') ? v : {};
        r.rejected = true; r.stage = 0;
        r.rejectReason = (info.reason || '').toString();
        r.rejectAt = Date.now();
        r.rejectBy = (info.by || '审核员').toString();
        r.rejectLog = r.rejectLog || [];
        r.rejectLog.push({ reason: r.rejectReason, by: r.rejectBy, at: r.rejectAt });
      } else {
        applyToggle(r, Number(v) || 0);
      }
      r.updatedAt = Date.now();
      // 保留系统字段，避免覆盖 _openid
      const data = Object.assign({}, r);
      delete data._id;
      await db.collection('records').doc(id).set({ data });
      return { ok: true, record: r, role };
    }

    if (action === 'delete') {
      if (role !== 'admin') return { ok: false, msg: '仅管理员可删除' };
      if (!id) return { ok: false, msg: '缺少记录ID' };
      const res = await db.collection('records').doc(id).get().catch(() => null);
      const r = res && res.data;
      const fids = collectFileIDs(r);
      await db.collection('records').doc(id).remove().catch(() => {});
      if (fids.length) await cloud.deleteFile({ fileList: fids }).catch(() => {});
      return { ok: true };
    }

    if (action === 'clearAll') {
      if (role !== 'admin') return { ok: false, msg: '仅管理员可清空' };
      const all = await db.collection('records').limit(1000).get().catch(() => ({ data: [] }));
      const list = all.data || [];
      for (const r of list) {
        const fids = collectFileIDs(r);
        await db.collection('records').doc(r._id).remove().catch(() => {});
        if (fids.length) await cloud.deleteFile({ fileList: fids }).catch(() => {});
      }
      return { ok: true, count: list.length };
    }

    return { ok: false, msg: '未知操作' };
  } catch (e) {
    return { ok: false, msg: '服务端错误: ' + (e && e.message ? e.message : e) };
  }
};
