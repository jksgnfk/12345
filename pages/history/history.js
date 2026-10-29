const store = require('../../utils/store.js');

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => x < 10 ? '0' + x : x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

Page({
  data: {
    authed: false, keyInput: '', keyErr: false,
    kw: '', filter: 'all',
    totalAll: 0, doneAll: 0, amount: '¥0.00',
    list: []
  },
  onLoad() {
    this.setData({ authed: !!store.getFinalAuth() });
  },
  onShow() {
    if (this.data.authed) store.refresh().then(() => this.load());
  },
  onKey(e) { this.setData({ keyInput: e.detail.value, keyErr: false }); },
  confirmKey() {
    const r = store.verifyFinalKey(this.data.keyInput);
    if (!r) { this.setData({ keyErr: true }); return; }
    store.setFinalAuth(r);
    this.setData({ authed: true, keyInput: '' });
    this.load();
  },
  onKw(e) { this.setData({ kw: e.detail.value }); this.load(); },
  clearKw() { this.setData({ kw: '' }); this.load(); },
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.f }); this.load(); },
  load() {
    const all = store.getRecords().slice().sort((a, b) => b.createdAt - a.createdAt);
    const f = this.data.filter;
    let list = all;
    if (f === 'ing') list = list.filter(r => !r.rejected && r.stage < 4);
    else if (f === 'done') list = list.filter(r => !r.rejected && r.stage >= 4);
    else if (f === 'rej') list = list.filter(r => r.rejected);
    const kw = (this.data.kw || '').trim().toLowerCase();
    if (kw) {
      list = list.filter(r => {
        const hay = [r.id, r.name, r.reason, r.type, r.academy, r.dept, r.payMethod]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
    }
    const s = store.stats();
    this.setData({
      totalAll: all.length, doneAll: s.done, amount: store.fmtMoney(s.amount),
      list: list.map(r => {
        const stage = store.stageLabel(r);
        const badge = r.rejected ? 'badge b-req' : 'badge b-spare';
        const filled = r.rejected ? 0 : r.stage;
        return {
          id: r.id, reason: r.reason, name: r.name, type: r.type,
          academy: r.academy, dept: r.dept, total: store.fmtMoney(r.total),
          stage, badge, date: fmtDate(r.createdAt),
          seg0: 0 < filled ? 'seg-on' : '', seg1: 1 < filled ? 'seg-on' : '',
          seg2: 2 < filled ? 'seg-on' : '', seg3: 3 < filled ? 'seg-on' : ''
        };
      })
    });
  },
  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?mode=track&id=' + e.currentTarget.dataset.id });
  },
  logoutAuth() {
    store.clearFinalAuth();
    this.setData({ authed: false, list: [], filter: 'all', kw: '' });
  }
});
