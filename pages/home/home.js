const store = require('../../utils/store.js');

Page({
  data: { user: {} },
  onShow() {
    this.setData({ user: store.getUser() || {} });
  },
  goSubmit() { wx.navigateTo({ url: '/pages/submit/submit' }); },
  goSchedule() { wx.navigateTo({ url: '/pages/schedule/schedule' }); },
  goTrack() { wx.navigateTo({ url: '/pages/track/track' }); },
  goHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  goAudit() {
    if (store.getAuditRole()) {
      wx.navigateTo({ url: '/pages/audit/audit' });
    } else {
      wx.navigateTo({ url: '/pages/audit/audit?needKey=1' });
    }
  },
  logout() {
    wx.showModal({
      title: '退出登录', content: '确认退出当前账号？',
      success: (r) => { if (r.confirm) { store.logout(); wx.reLaunch({ url: '/pages/login/login' }); } }
    });
  }
});
