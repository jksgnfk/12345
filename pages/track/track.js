const store = require('../../utils/store.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => x < 10 ? '0' + x : x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: { list: [] },
  onShow() { store.refresh().then(() => this.load()); },
  load() {
    const u = store.getUser() || {};
    const uname = u.username || '';
    const list = store.getRecords()
      .filter(r => (r.userId || r.name || '') === uname)
      .sort((a, b) => b.createdAt - a.createdAt);
    this.setData({
      list: list.map(r => {
        const stage = store.stageLabel(r);
        const badge = r.rejected ? 'badge b-req' : 'badge b-spare';
        const filled = r.rejected ? 0 : r.stage;
        return {
          id: r.id, reason: r.reason, type: r.type, total: store.fmtMoney(r.total),
          stage, badge,
          seg0: 0 < filled ? 'seg-on' : '',
          seg1: 1 < filled ? 'seg-on' : '',
          seg2: 2 < filled ? 'seg-on' : '',
          seg3: 3 < filled ? 'seg-on' : '',
          time: fmtTime(r.updatedAt)
        };
      })
    });
  },
  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?mode=track&id=' + e.currentTarget.dataset.id });
  }
});
