const store = require('../../utils/store.js');

const TYPES = ['活动', '采购', '差旅', '培训', '其他'];

function countMats(rec) {
  let c = 0;
  Object.keys(rec.materials || {}).forEach(k => { c += (rec.materials[k] || []).length; });
  return c;
}

Page({
  data: {
    user: {},
    types: TYPES,
    pays: store.PAY_METHODS,
    typeIndex: 0,
    payIndex: 0,
    clothing: false,
    reason: '',
    total: '',
    totalFmt: '¥0.00',
    note: '',
    mats: [],
    files: {},
    summaryCount: 0,
    myList: []
  },

  onLoad() {
    const u = store.getUser() || {};
    this.setData({ user: u });
    this.initFiles();
    this.refreshMats();
    this.loadMy();
  },

  onShow() {
    store.refresh().then(() => this.loadMy());
  },

  initFiles() {
    const keys = {};
    TYPES.forEach(t => store.getMaterials(t, false).forEach(m => { keys[m.key] = 1; }));
    store.getMaterials('活动', true).forEach(m => { keys[m.key] = 1; });
    const files = {};
    Object.keys(keys).forEach(k => { files[k] = []; });
    this.setData({ files });
  },

  refreshMats() {
    const cur = TYPES[this.data.typeIndex];
    const mats = store.getMaterials(cur, this.data.clothing).map(m => ({
      key: m.key, name: m.name, required: m.required, multiple: m.multiple,
      list: this.data.files[m.key] || []
    }));
    let c = 0;
    mats.forEach(m => { c += m.list.length; });
    this.setData({ mats, summaryCount: c });
  },

  onType(e) { this.setData({ typeIndex: Number(e.detail.value) }); this.refreshMats(); },
  onPay(e) { this.setData({ payIndex: Number(e.detail.value) }); },
  onClothing(e) { this.setData({ clothing: e.detail.value }); this.refreshMats(); },
  onReason(e) { this.setData({ reason: e.detail.value }); },
  onTotal(e) {
    const v = e.detail.value;
    this.setData({ total: v, totalFmt: store.fmtMoney(v) });
  },
  onNote(e) { this.setData({ note: e.detail.value }); },

  updateKey(key, arr) {
    const files = this.data.files;
    files[key] = arr;
    this.setData({ files });
    this.refreshMats();
  },

  chooseFile(e) {
    const key = e.currentTarget.dataset.key;
    const multiple = e.currentTarget.dataset.multiple;
    let cur = (this.data.files[key] || []).slice();
    if (!multiple && cur.length > 0) {
      wx.showToast({ title: '该项仅支持单份', icon: 'none' }); return;
    }
    wx.showActionSheet({
      itemList: ['图片', '文件（PDF/Word/Excel/PPT）'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.chooseMedia({
            count: multiple ? 9 : 1, mediaType: ['image'], sourceType: ['album', 'camera'],
            success: (r) => {
              const tasks = r.tempFiles.map(tf =>
                store.uploadFile(tf.tempFilePath, 'img.jpg')
                  .then(res => ({ type: 'image', name: '图片', path: res.path, fileID: res.fileID || null, ext: 'IMG' }))
              );
              Promise.all(tasks).then(files => { files.forEach(f => cur.push(f)); this.updateKey(key, cur); });
            }
          });
        } else {
          wx.chooseMessageFile({
            count: multiple ? 9 : 1, type: 'file',
            extension: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg'],
            success: (r) => {
              const tasks = r.tempFiles.map(tf => {
                const name = tf.name;
                const ext = (name.split('.').pop() || 'FILE').toUpperCase();
                const isImg = ['PNG', 'JPG', 'JPEG'].indexOf(ext) >= 0;
                return store.uploadFile(tf.path, name)
                  .then(res => ({ type: isImg ? 'image' : 'file', name, path: res.path, fileID: res.fileID || null, ext: isImg ? 'IMG' : ext }));
              });
              Promise.all(tasks).then(files => { files.forEach(f => cur.push(f)); this.updateKey(key, cur); });
            }
          });
        }
      }
    });
  },

  delFile(e) {
    const key = e.currentTarget.dataset.key;
    const i = Number(e.currentTarget.dataset.i);
    const arr = (this.data.files[key] || []).slice();
    const f = arr[i];
    if (f) store.removeFile(f.path);
    arr.splice(i, 1);
    this.updateKey(key, arr);
  },

  previewImg(e) {
    const key = e.currentTarget.dataset.key;
    const i = Number(e.currentTarget.dataset.i);
    const arr = (this.data.files[key] || []).filter(f => f.type === 'image').map(f => f.path);
    const cur = this.data.files[key][i] ? this.data.files[key][i].path : arr[0];
    wx.previewImage({ urls: arr, current: cur });
  },

  openFile(e) {
    const key = e.currentTarget.dataset.key;
    const i = Number(e.currentTarget.dataset.i);
    const f = this.data.files[key][i];
    if (!f) return;
    if (f.fileID) {
      wx.cloud.downloadFile({ fileID: f.fileID })
        .then(r => wx.openDocument({ filePath: r.tempFilePath, showMenu: true }))
        .catch(() => wx.showToast({ title: '无法打开该文件', icon: 'none' }));
    } else {
      wx.openDocument({ filePath: f.path, showMenu: true, fail: () => wx.showToast({ title: '无法打开该文件', icon: 'none' }) });
    }
  },

  submit() {
    const u = this.data.user;
    const reason = (this.data.reason || '').trim();
    const total = parseFloat(this.data.total) || 0;
    if (!reason) { wx.showToast({ title: '请填写报销事由', icon: 'none' }); return; }
    if (total <= 0) { wx.showToast({ title: '请填写报销总额', icon: 'none' }); return; }
    const cur = TYPES[this.data.typeIndex];
    const mats = store.getMaterials(cur, this.data.clothing);
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (m.required && (!this.data.files[m.key] || this.data.files[m.key].length === 0)) {
        wx.showToast({ title: '请上传【' + m.name + '】', icon: 'none' }); return;
      }
    }
    const matObj = {};
    Object.keys(this.data.files).forEach(k => { matObj[k] = this.data.files[k]; });
    const rec = {
      id: store.genId(),
      userId: u.username || '',
      name: u.username || '', sid: '', academy: u.academy || '', dept: u.dept || '',
      phone: '',
      reason, type: cur, payMethod: store.PAY_METHODS[this.data.payIndex],
      clothing: this.data.clothing, total, note: (this.data.note || '').trim(),
      materials: matObj, stage: 0, rejected: false, stageLog: { 0: Date.now() },
      createdAt: Date.now(), updatedAt: Date.now()
    };
    store.saveRecord(rec);
    wx.showToast({ title: '提交成功', icon: 'success' });
    this.resetForm();
    this.loadMy();
  },

  resetForm() {
    this.initFiles();
    this.setData({ reason: '', total: '', totalFmt: '¥0.00', note: '', clothing: false, typeIndex: 0, payIndex: 0 });
    this.refreshMats();
  },

  loadMy() {
    const u = this.data.user;
    const list = store.getRecords()
      .filter(r => (r.userId || r.name || '') === u.username)
      .sort((a, b) => b.createdAt - a.createdAt);
    this.setData({
      myList: list.map(r => ({
        id: r.id, reason: r.reason, name: r.name, type: r.type,
        total: store.fmtMoney(r.total), stage: store.stageLabel(r), count: countMats(r)
      }))
    });
  },

  openMy(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/detail/detail?mode=submit&id=' + id });
  }
});
