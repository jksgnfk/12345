/* ============================================================
 * utils/privacy.js — 隐私授权（最小化、按需申请）
 * 仅在用户真正提交身份信息时才申请授权，不在启动时弹出。
 * 对不支持该接口的旧基础库做兼容降级，保证功能不受影响。
 * ============================================================ */

/* 申请隐私授权。返回 Promise<boolean>：true=已同意/无需授权，false=用户拒绝。
 * 调用方只在「需要采集用户信息」的那一刻调用本函数（当前仅登录登记）。 */
function ensurePrivacy() {
  return new Promise((resolve) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      // 旧基础库无隐私接口：直接放行，不阻断功能
      resolve(true);
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => resolve(true),
      fail: () => resolve(false),
      complete: () => {}
    });
  });
}

/* 打开隐私协议全文（供登录页「《隐私协议》」链接使用） */
function openPrivacyDetail() {
  if (typeof wx.openPrivacyContract === 'function') {
    wx.openPrivacyContract({ fail: () => {} });
  }
}

module.exports = { ensurePrivacy, openPrivacyDetail };
