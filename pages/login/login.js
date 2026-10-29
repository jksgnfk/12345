const store = require('../../utils/store.js');

Page({
  data: {
    user: { username: '', academy: '', dept: '' }
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
  login() {
    const username = (this.data.user.username || '').trim();
    if (!username) { wx.showToast({ title: '请填写用户名', icon: 'none' }); return; }
    store.setUser({
      username,
      academy: (this.data.user.academy || '').trim(),
      dept: (this.data.user.dept || '').trim()
    });
    wx.reLaunch({ url: '/pages/home/home' });
  }
});
