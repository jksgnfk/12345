const store = require('../../utils/store.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => x < 10 ? '0' + x : x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function roleLabel(r) {
  if (r === 'admin') return '最高管理';
  if (r === 'audit') return '审核员';
  return r || '审核员';
}

Page({
  data: { mode: 'track', rec: null, stage: '', badge: '', total: '', matList: [], pipe: [], showReject: false, rejectText: '' },
  onLoad(q) {
    this._id = q.id;
    this.setData({ mode: q.mode || 'track' });
    store.refresh().then(() => this.render());
  },
  render() {
    const r = store.getRecord(this._id);
    if (!r) { this.setData({ rec: null }); return; }
    const stage = store.stageLabel(r);
    const badge = r.rejected ? 'badge b-req' : 'badge b-spare';
    const matList = Object.keys(r.materials || {}).map(k => ({
      key: k, name: store.MATNAME[k] || k, list: r.materials[k] || []
    }));
    const pipe = store.STAGES.map(s => {
      const done = !r.rejected && r.stage >= s.k;
      const current = !r.rejected && r.stage === s.k;
      const rej = r.rejected && s.k === 0;
      return {
        k: s.k, name: s.name, done, current, rej,
        time: (r.stageLog && r.stageLog[s.k]) ? fmtTime(r.stageLog[s.k]) : ''
      };
    });
    this.setData({
      rec: r, stage, badge, total: store.fmtMoney(r.total), matList, pipe,
      rejectReason: r.rejected ? (r.rejectReason || '') : '',
      rejectAt: (r.rejected && r.rejectAt) ? fmtTime(r.rejectAt) : '',
      rejectBy: r.rejected ? roleLabel(r.rejectBy) : ''
    });
  },
  tapNode(e) {
    if (this.data.mode !== 'audit') return;
    const k = Number(e.currentTarget.dataset.k);
    const r = store.getRecord(this._id);
    if (!r) return;
    store.toggleStage(r, k).then(() => this.render());
  },
  openReject() {
    this.setData({ showReject: true, rejectText: '' });
  },
  onRejectInput(e) { this.setData({ rejectText: e.detail.value }); },
  cancelReject() { this.setData({ showReject: false }); },
  noop() {},
  confirmReject() {
    const r = store.getRecord(this._id);
    if (!r) return;
    const txt = (this.data.rejectText || '').trim();
    if (!txt) { wx.showToast({ title: '请填写退回原因', icon: 'none' }); return; }
    store.rejectRecord(r, txt).then(() => {
      this.setData({ showReject: false });
      this.render();
      wx.showToast({ title: '已退回', icon: 'none' });
    });
  },
  previewImg(e) {
    const key = e.currentTarget.dataset.key, i = Number(e.currentTarget.dataset.i);
    const arr = this.data.rec.materials[key].filter(f => f.type === 'image').map(f => f.path);
    const cur = this.data.rec.materials[key][i] ? this.data.rec.materials[key][i].path : arr[0];
    wx.previewImage({ urls: arr, current: cur });
  },
  openFile(e) {
    const key = e.currentTarget.dataset.key, i = Number(e.currentTarget.dataset.i);
    const f = this.data.rec.materials[key][i];
    if (!f) return;
    if (f.fileID) {
      wx.cloud.downloadFile({ fileID: f.fileID })
        .then(r => wx.openDocument({ filePath: r.tempFilePath, showMenu: true }))
        .catch(() => wx.showToast({ title: '无法打开该文件', icon: 'none' }));
    } else {
      wx.openDocument({ filePath: f.path, showMenu: true, fail: () => wx.showToast({ title: '无法打开该文件', icon: 'none' }) });
    }
  },
  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: '/pages/home/home' }) });
  }
});
