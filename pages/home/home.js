const store = require('../../utils/store.js');
const announce = require('../../utils/announce.js');

Page({
  data: { user: {}, isGuest: true, announceUnread: 0 },
  onShow() {
    const u = store.getUser() || null;
    this.setData({ user: u || {}, isGuest: !u });
    // 公告未读红点：拉取最新列表后计算未读数
    announce.refresh().then(() => {
      this.setData({ announceUnread: announce.unreadCount() });
    }).catch(() => {
      this.setData({ announceUnread: announce.unreadCount() });
    });
  },
  /* 游客模式：需要先登录的功能在此统一引导，绝不拦截首页浏览 */
  needLogin() {
    if (!store.getUser()) {
      wx.showModal({
        title: '需要登录',
        content: '该功能需登录后使用，是否前往身份登记？',
        confirmText: '去登录', cancelText: '先逛逛',
        success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/login/login' }); }
      });
      return true;
    }
    return false;
  },
  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goSubmit() { if (this.needLogin()) return; wx.navigateTo({ url: '/pages/submit/submit' }); },
  goAnnounce() { wx.navigateTo({ url: '/pages/announce/announce' }); },
  goTrack() { if (this.needLogin()) return; wx.navigateTo({ url: '/pages/track/track' }); },
  goHistory() { if (this.needLogin()) return; wx.navigateTo({ url: '/pages/history/history' }); },
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
