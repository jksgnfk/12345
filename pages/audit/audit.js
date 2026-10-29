const store = require('../../utils/store.js');

Page({
  data: {
    authed: false, role: '', keyInput: '', keyErr: false,
    stats: { audit: 0, signed: 0, caiwu: 0, done: 0 }, amount: '¥0.00',
    filter: 'all', list: []
  },
  onLoad() {
    this.setData({ authed: !!store.getAuditRole() });
  },
  onShow() {
    if (this.data.authed) {
      this.setData({ role: store.getAuditRole() || '' });
      store.refresh().then(() => this.load());
    }
  },
  onKey(e) { this.setData({ keyInput: e.detail.value, keyErr: false }); },
  confirmKey() {
    const r = store.verifyKey((this.data.keyInput || '').trim());
    if (!r) { this.setData({ keyErr: true }); return; }
    store.setAuditRole(r);
    store.setAuditKey((this.data.keyInput || '').trim());
    this.setData({ authed: true, role: r, keyInput: '' });
    this.load();
  },
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.f }); this.load(); },
  load() {
    const role = store.getAuditRole() || '';
    const s = store.stats();
    let list = store.getRecords().slice().sort((a, b) => b.createdAt - a.createdAt);
    const f = this.data.filter;
    if (f === 'ing') list = list.filter(r => !r.rejected && r.stage < 4);
    else if (f === 'done') list = list.filter(r => !r.rejected && r.stage >= 4);
    else if (f === 'rej') list = list.filter(r => r.rejected);
    this.setData({
      role, stats: s, amount: store.fmtMoney(s.amount),
      list: list.map(r => {
        const stage = store.stageLabel(r);
        const badge = r.rejected ? 'badge b-req' : 'badge b-spare';
        const filled = r.rejected ? 0 : r.stage;
        return {
          id: r.id, reason: r.reason, name: r.name, type: r.type, total: store.fmtMoney(r.total),
          stage, badge,
          seg0: 0 < filled ? 'seg-on' : '', seg1: 1 < filled ? 'seg-on' : '',
          seg2: 2 < filled ? 'seg-on' : '', seg3: 3 < filled ? 'seg-on' : ''
        };
      })
    });
  },
  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?mode=audit&id=' + e.currentTarget.dataset.id });
  },
  exportData() {
    const json = store.exportJSON();
    wx.setClipboardData({ data: json, success: () => wx.showToast({ title: '已复制备份JSON', icon: 'none' }) });
  },
  importData() {
    wx.showModal({
      title: '导入恢复', editable: true, placeholderText: '粘贴此前导出的JSON',
      success: (res) => {
        if (res.confirm) {
          store.importJSON(res.content || '').then(() => {
            wx.showToast({ title: '导入成功', icon: 'success' }); this.load();
          }).catch(() => { wx.showToast({ title: '格式错误', icon: 'none' }); });
        }
      }
    });
  },
  clearAll() {
    wx.showModal({
      title: '清空全部', content: '将删除所有报销记录与附件，不可恢复！',
      success: (r) => { if (r.confirm) { store.clearAll(); wx.showToast({ title: '已清空', icon: 'none' }); this.load(); } }
    });
  },
  logoutRole() {
    store.clearAuditRole();
    store.clearAuditKey();
    this.setData({ authed: false, role: '', list: [], filter: 'all' });
  }
});
