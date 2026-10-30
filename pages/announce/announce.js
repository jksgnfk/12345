const store = require('../../utils/store.js');
const announce = require('../../utils/announce.js');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => x < 10 ? '0' + x : x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    authed: false,        // 是否为最高管理（可发布/修改/删除）
    loading: true,
    list: [],             // 渲染用公告列表（含 unread 标记）
    unread: 0,
    showEditor: false,    // 发布/编辑面板
    editingId: null,      // null=新增；否则为被编辑公告 _id
    formTitle: '',
    formContent: '',
    formPinned: false
  },

  onLoad() {
    this.setData({ authed: store.isAdmin() });
  },

  onShow() {
    this.refreshBoard();
  },

  /* 离开公告栏时自动标记为已读（红点随之消失）；查看期间保留未读高亮 */
  onHide() {
    announce.setLastRead(Date.now());
  },

  refreshBoard() {
    this.setData({ loading: true });
    announce.refresh().then(() => {
      this.render();
      this.setData({ loading: false });
    }).catch(() => {
      this.render();
      this.setData({ loading: false });
    });
  },

  render() {
    const lr = announce.getLastRead();
    const list = announce.getList().map(a => ({
      _id: a._id,
      title: a.title,
      content: a.content,
      pinned: !!a.pinned,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      timeText: fmtTime(a.updatedAt || a.createdAt),
      unread: (a.updatedAt || a.createdAt || 0) > lr
    }));
    const unread = list.filter(x => x.unread).length;
    this.setData({ list, unread });
  },

  /* 全部标记为已读 */
  markAllRead() {
    announce.setLastRead(Date.now());
    this.render();
    wx.showToast({ title: '已全部阅读', icon: 'none' });
  },

  /* ---------- 管理：发布 / 编辑 ---------- */
  openAdd() {
    if (!this.data.authed) { this.notAdmin(); return; }
    this.setData({
      showEditor: true, editingId: null,
      formTitle: '', formContent: '', formPinned: false
    });
  },

  openEdit(e) {
    if (!this.data.authed) { this.notAdmin(); return; }
    const id = e.currentTarget.dataset.id;
    const a = announce.getList().find(x => x._id === id);
    if (!a) return;
    this.setData({
      showEditor: true, editingId: id,
      formTitle: a.title, formContent: a.content || '', formPinned: !!a.pinned
    });
  },

  closeEditor() {
    this.setData({ showEditor: false });
  },

  onTitle(e) { this.setData({ formTitle: e.detail.value }); },
  onContent(e) { this.setData({ formContent: e.detail.value }); },
  onPinned(e) { this.setData({ formPinned: e.detail.value }); },

  /* 云端写操作需携带最高管理密钥；本地模式仅靠角色即可 */
  ensureKey() {
    return new Promise((resolve) => {
      if (!announce.CLOUD_ENABLED) { resolve(''); return; }
      const k = announce.getKey();
      if (k) { resolve(k); return; }
      wx.showModal({
        title: '管理验证', editable: true, placeholderText: '请输入最高管理密钥',
        success: (r) => {
          if (r.confirm) {
            const v = (r.content || '').trim();
            if (v !== store.ADMIN_KEY) { wx.showToast({ title: '密钥错误', icon: 'none' }); resolve(null); }
            else { announce.setKey(v); resolve(v); }
          } else resolve(null);
        }
      });
    });
  },

  save() {
    const title = (this.data.formTitle || '').trim();
    if (!title) { wx.showToast({ title: '请填写标题', icon: 'none' }); return; }
    const isEdit = !!this.data.editingId;
    this.ensureKey().then(key => {
      if (key === null) return; // 取消或密钥错误
      wx.showLoading({ title: isEdit ? '保存中' : '发布中', mask: true });
      const patch = { title, content: this.data.formContent, pinned: this.data.formPinned };
      const task = isEdit
        ? announce.update(this.data.editingId, patch, key)
        : announce.add(patch, key);
      task.then(res => {
        wx.hideLoading();
        if (res.ok) {
          wx.showToast({ title: isEdit ? '已保存' : '已发布', icon: 'success' });
          this.setData({ showEditor: false });
          this.refreshBoard();
        } else {
          wx.showToast({ title: res.msg || '操作失败', icon: 'none' });
        }
      }).catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '操作失败', icon: 'none' });
      });
    });
  },

  removeAnnounce(e) {
    if (!this.data.authed) { this.notAdmin(); return; }
    const id = e.currentTarget.dataset.id;
    const a = announce.getList().find(x => x._id === id);
    wx.showModal({
      title: '删除公告', content: '确认删除《' + (a ? a.title : '') + '》？此操作不可恢复。',
      success: (r) => {
        if (!r.confirm) return;
        this.ensureKey().then(key => {
          if (key === null) return;
          wx.showLoading({ title: '删除中', mask: true });
          announce.remove(id, key).then(res => {
            wx.hideLoading();
            if (res.ok) { wx.showToast({ title: '已删除', icon: 'success' }); this.refreshBoard(); }
            else { wx.showToast({ title: res.msg || '删除失败', icon: 'none' }); }
          }).catch(() => { wx.hideLoading(); wx.showToast({ title: '删除失败', icon: 'none' }); });
        });
      }
    });
  },

  notAdmin() {
    wx.showToast({ title: '仅最高管理可操作', icon: 'none' });
  },

  goBack() { wx.navigateBack({ delta: 1 }); },

  noop() {}
});
