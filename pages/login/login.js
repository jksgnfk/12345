const store = require('../../utils/store.js');
const { ensurePrivacy, openPrivacyDetail } = require('../../utils/privacy.js');

Page({
  data: {
    user: { username: '', academy: '', dept: '' },
    agreed: false
  },
  onLoad() {
    const u = store.getUser();
    if (u) {
      this.setData({
        user: { username: u.username || '', academy: u.academy || '', dept: u.dept || '' }
      });
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }
  },
  onUser(e) { this.setData({ 'user.username': e.detail.value }); },
  onAcademy(e) { this.setData({ 'user.academy': e.detail.value }); },
  onDept(e) { this.setData({ 'user.dept': e.detail.value }); },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },
  login() {
    const username = (this.data.user.username || '').trim();
    if (!username) { wx.showToast({ title: '请填写用户名', icon: 'none' }); return; }
    // 必须用户主动勾选同意隐私协议，不得默认/强制同意
    if (!this.data.agreed) { wx.showToast({ title: '请先阅读并勾选同意《隐私协议》', icon: 'none' }); return; }
    // 仅在此刻（真正采集身份信息时）按需申请隐私授权，不在启动时弹出
    ensurePrivacy().then((ok) => {
      if (!ok) {
        wx.showToast({ title: '请先同意隐私协议', icon: 'none' });
        return;
      }
      store.setUser({
        username,
        academy: (this.data.user.academy || '').trim(),
        dept: (this.data.user.dept || '').trim()
      });
      wx.reLaunch({ url: '/pages/home/home' });
    });
  },
  /* 登录页底部《隐私协议》入口 */
  openPrivacy() { openPrivacyDetail(); }
});
