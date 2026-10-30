const store = require('../../utils/store.js');
const announce = require('../../utils/announce.js');

Page({
  data: { user: {}, announceUnread: 0 },
  onShow() {
    this.setData({ user: store.getUser() || {} });
    // 公告未读红点：拉取最新列表后计算未读数
    announce.refresh().then(() => {
      this.setData({ announceUnread: announce.unreadCount() });
    }).catch(() => {
      this.setData({ announceUnread: announce.unreadCount() });
    });
  },
  goSubmit() { wx.navigateTo({ url: '/pages/submit/submit' }); },
  goSchedule() { wx.navigateTo({ url: '/pages/schedule/schedule' }); },
  goAnnounce() { wx.navigateTo({ url: '/pages/announce/announce' }); },
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
