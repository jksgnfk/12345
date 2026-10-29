/* ============================================================
 * 宸阳书院报销系统 · 后端调用层
 * 审核写操作（改进程/退回/删除/清空）统一走这里：
 *   - 配置了 CLOUD_RUN_SERVICE 时，优先调用微信云托管后端 /api/audit
 *   - 未配置或调用失败时，自动回退到 auditStage 云函数
 * 因此无论云托管是否就绪，小程序都不会因后端切换而失效。
 * ============================================================ */
const cfg = require('./config.js');

function parseBody(res) {
  let d = res && res.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  return d || {};
}

function callAudit(action, id, v, key) {
  const svc = cfg.CLOUD_RUN_SERVICE;
  const canContainer = !!svc && typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callContainer === 'function';

  if (!canContainer) {
    return wx.cloud.callFunction({ name: 'auditStage', data: { action, id, v, key } })
      .then(r => (r && r.result) || { ok: false });
  }

  return new Promise((resolve) => {
    wx.cloud.callContainer({
      config: { env: cfg.CLOUD_RUN_ENV || cfg.ENV_ID },
      path: '/api/audit',
      method: 'POST',
      header: { 'X-WX-SERVICE': svc, 'content-type': 'application/json' },
      data: { action, id, v, key },
      success: (res) => resolve(parseBody(res)),
      fail: () => {
        // 后端不可用时回退到云函数，保证操作不丢
        wx.cloud.callFunction({ name: 'auditStage', data: { action, id, v, key } })
          .then(r => resolve((r && r.result) || { ok: false }))
          .catch(() => resolve({ ok: false }));
      }
    });
  });
}

module.exports = { callAudit };
