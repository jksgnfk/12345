const store = require('../../utils/store.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => x < 10 ? '0' + x : x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: { mode: 'track', rec: null, stage: '', badge: '', total: '', matList: [], pipe: [] },
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
    this.setData({ rec: r, stage, badge, total: store.fmtMoney(r.total), matList, pipe });
  },
  tapNode(e) {
    if (this.data.mode !== 'audit') return;
    const k = Number(e.currentTarget.dataset.k);
    const r = store.getRecord(this._id);
    if (!r) return;
    store.toggleStage(r, k).then(() => this.render());
  },
  reject() {
    const r = store.getRecord(this._id);
    if (!r) return;
    wx.showModal({
      title: '退回修改', content: '确认将该单据退回提交人修改？',
      success: (res) => {
        if (res.confirm) { store.rejectRecord(r).then(() => { this.render(); wx.showToast({ title: '已退回', icon: 'none' }); }); }
      }
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
