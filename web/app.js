/* ============================================================
 * 宸阳书院报销系统 · 网页版主逻辑
 * 功能对齐小程序 8 个页面：登录 / 首页工作台 / 提交 / 进度 /
 * 历史 / 审核 / 详情 / 公告，另加数据管理与一键导出。
 * 数据：localStorage（元数据）+ IndexedDB（材料文件本体）。
 *      线上部署且 /api/ping 可用时自动进入「多端共享」：单据与公告走 /api/state，
 *      所有打开同一链接的设备共用一份数据；file:// 或纯静态托管自动降级为纯本地。
 *      身份 / 角色 / 密钥 / 未读时间戳始终只留在本机；材料文件本体在共享模式下
 *      会按需上传到本站 /api/file，供其它设备预览与导出真实图片。
 * 依赖：zip.js（window.CyZip）
 * ============================================================ */
(function () {
  'use strict';

  var Z = (typeof window !== 'undefined' && window.CyZip) || {};
  var buildZip = Z.buildZip, unzipStore = Z.unzipStore, toUint8 = Z.toUint8,
      textBuffer = Z.textBuffer, utf8Decode = Z.utf8Decode;

  /* ---------- 口径常量：逐项对齐 utils/store.js ---------- */
  var STAGES = [
    { k: 0, name: '已提交' }, { k: 1, name: '审核中' }, { k: 2, name: '老师已签字' },
    { k: 3, name: '提交至计财处' }, { k: 4, name: '项目已完成' }
  ];
  var MATNAME = {
    invoice: '发票', plan: '策划案（附预算表）', pay: '支付截图', purchase: '商品购买截图',
    proof: '材料证明截图', claim: '领用清单', other: '其他（备用）'
  };
  function mk(key, required, multiple) { return { key: key, required: required, multiple: multiple }; }
  var TYPE_MATERIALS = {
    '活动': [mk('invoice', true, true), mk('plan', true, false), mk('pay', true, true), mk('purchase', true, true)],
    '采购': [mk('invoice', true, true), mk('pay', true, true), mk('purchase', true, true)],
    '差旅': [mk('invoice', true, true), mk('pay', true, true), mk('proof', false, true)],
    '培训': [mk('invoice', true, true), mk('plan', false, false), mk('pay', true, true)],
    '其他': [mk('invoice', true, true), mk('pay', false, true)]
  };
  var CLOTHING_MAT = mk('claim', true, false);
  var OTHER_MAT = mk('other', false, true);
  var PAY_METHODS = ['学生付款', '老师工资卡付款', '老师公务卡', '老师对公卡付款', '学校对公账户付款'];
  var TYPES = ['活动', '采购', '差旅', '培训', '其他'];
  var MAX_FILES = 50;
  var EXPIRE_MS = 30 * 24 * 3600 * 1000;
  /* 权限密钥只以 SHA-256 摘要形式存在（见下方 KEY_HASH），不保留明文 */
  var K_STATE = 'cy_web_v2_state', K_THEME = 'cy_web_v2_theme';

  function getMaterials(type, clothing) {
    var list = (TYPE_MATERIALS[type] || TYPE_MATERIALS['其他']).slice();
    if (clothing) list.push(CLOTHING_MAT);
    list.push(OTHER_MAT);
    return list;
  }

  /* ---------- 通用工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function sanitize(n) { return String(n || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtMoney(n) { return '¥' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts)); if (isNaN(d)) return '—';
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts)); if (isNaN(d)) return '';
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function dateStr() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function guessExt(p) {
    var m = String(p || '').split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : 'bin';
  }
  /* 按文件头判定真实类型：避免声明扩展名与内容不符时，图片被写成 .txt/.bin 而打不开 */
  function sniff(buf) {
    var b = toUint8(buf), n = b.length;
    if (n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
        b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A)
      return { mime: 'image/png', ext: 'png', image: true };
    if (n >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF)
      return { mime: 'image/jpeg', ext: 'jpg', image: true };
    if (n >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
      return { mime: 'image/gif', ext: 'gif', image: true };
    if (n >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
      return { mime: 'image/webp', ext: 'webp', image: true };
    if (n >= 2 && b[0] === 0x42 && b[1] === 0x4D)
      return { mime: 'image/bmp', ext: 'bmp', image: true };
    if (n >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
      return { mime: 'application/pdf', ext: 'pdf', image: false };
    if (n >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04)
      return { mime: 'application/octet-stream', ext: 'zip', image: false };
    return null;
  }
  var EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip', bin: 'application/octet-stream'
  };
  function fileType(f, buf) {
    var s = sniff(buf);
    if (s) return s;
    var e = String((f && f.ext) || guessExt((f && (f.path || f.name)) || '')).toLowerCase();
    if (e === 'jpeg') e = 'jpg';
    if (e === 'img' || !e) e = guessExt((f && (f.path || f.name)) || '');
    return {
      mime: EXT_MIME[e] || 'application/octet-stream',
      ext: e || 'bin',
      image: /^(png|jpg|gif|webp|bmp)$/.test(e)
    };
  }
  function bytesToBase64(buf) {
    var b = toUint8(buf), s = '';
    for (var i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function countMats(r) {
    var n = 0; Object.keys(r.materials || {}).forEach(function (k) { n += (r.materials[k] || []).length; });
    return n;
  }
  function stageLabel(r) { return r.rejected ? '已退回' : (STAGES[r.stage] || STAGES[0]).name; }
  function stageTag(r) {
    return r.rejected ? '<span class="tag rj">已退回</span>'
      : '<span class="tag s' + Math.min(4, Math.max(0, Number(r.stage) || 0)) + '">' + esc(stageLabel(r)) + '</span>';
  }
  function genId(p) { return (p || 'R') + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function uid(p) { return (p || 'f') + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function roleLabel(r) { return r === 'admin' ? '最高管理' : (r === 'audit' ? '审核员' : '审核员'); }
  function isAdmin() { return state.role === 'admin'; }
  function isAuditor() { return state.role === 'admin' || state.role === 'audit'; }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  /* ---------- 下载位置：默认桌面（File System Access API） ----------
   * 浏览器不允许网页静默改写系统默认下载目录，因此首次导出时在用户点击的手势内
   * 弹出目录选择（startIn:'desktop' 默认定位桌面），授权后把句柄存入 IndexedDB，
   * 之后所有导出 / 下载直接写入该文件夹；不支持或拒绝授权时降级为浏览器默认下载。 */
  var DIR_PREF_DB = 'cy_web_prefs', DIR_PREF_KEY = 'downloadDir';
  var dirHandle = null, dirPromise = null, dirDeclinedAt = 0, _prefDB = null;
  function fsDirSupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
      && (window.isSecureContext || /^https:$/.test(location.protocol));
  }
  function openPrefDB() {
    return new Promise(function (resolve) {
      if (_prefDB) return resolve(_prefDB);
      if (!('indexedDB' in window)) return resolve(null);
      var req;
      try { req = indexedDB.open(DIR_PREF_DB, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('prefs')) d.createObjectStore('prefs');
      };
      req.onsuccess = function () { _prefDB = req.result; resolve(_prefDB); };
      req.onerror = function () { resolve(null); };
      setTimeout(function () { if (!_prefDB) resolve(null); }, 1500);
    });
  }
  function getPref(key) {
    return openPrefDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction('prefs', 'readonly').objectStore('prefs').get(key);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  function setPref(key, val) {
    return openPrefDB().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction('prefs', 'readwrite');
          tx.objectStore('prefs').put(val, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }
  function dirPermission(h, request) {
    if (!h || typeof h.queryPermission !== 'function') return Promise.resolve(true);
    var opt = { mode: 'readwrite' };
    return Promise.resolve(h.queryPermission(opt)).then(function (p) {
      if (p === 'granted') return true;
      if (!request || typeof h.requestPermission !== 'function') return false;
      return Promise.resolve(h.requestPermission(opt)).then(function (q) { return q === 'granted'; });
    }).catch(function () { return false; });
  }
  function renderDownloadStatus() {
    var box = $('dlDirStatus'), quick = $('dlQuickStatus'), btn = $('dlQuickBtn');
    var ok = !!dirHandle;
    var msg = !fsDirSupported()
      ? '当前浏览器不支持指定目录：请在浏览器「设置 → 下载内容 → 位置」把下载目录改成桌面。'
      : (ok ? '已设为「' + (dirHandle.name || '自定义目录') + '」：所有导出与下载直接保存到该文件夹。'
            : '尚未设为桌面：首次导出时会弹出文件夹选择（默认定位桌面），授权一次后长期生效。');
    if (box) { box.textContent = msg; box.classList.toggle('dl-warn', !ok); }
    if (quick) quick.textContent = ok ? '下载位置：' + (dirHandle.name || '自定义目录') : '下载位置：浏览器默认';
    if (btn) btn.textContent = ok ? '更改下载目录' : '设为桌面';
  }
  function loadDownloadDir() {
    if (!fsDirSupported()) { renderDownloadStatus(); return Promise.resolve(); }
    return getPref(DIR_PREF_KEY).then(function (h) {
      if (!h) { renderDownloadStatus(); return; }
      return dirPermission(h, false).then(function (ok) {
        dirHandle = ok ? h : null;
        renderDownloadStatus();
      });
    }).catch(function () { renderDownloadStatus(); });
  }
  function pickDesktopDir(silent) {
    if (!fsDirSupported()) {
      if (!silent) toast('当前浏览器不支持自定义下载目录');
      renderDownloadStatus(); return Promise.resolve(null);
    }
    var p;
    try { p = window.showDirectoryPicker({ id: 'cyDesktop', mode: 'readwrite', startIn: 'desktop' }); }
    catch (e) {
      try { p = window.showDirectoryPicker({ id: 'cyDesktop', mode: 'readwrite' }); }
      catch (e2) { p = Promise.reject(e2); }
    }
    return Promise.resolve(p).then(function (h) {
      return dirPermission(h, true).then(function (ok) {
        if (!ok) { if (!silent) toast('未获得目录写入权限'); return null; }
        dirHandle = h; dirDeclinedAt = 0;
        return setPref(DIR_PREF_KEY, h).then(function () {
          renderDownloadStatus();
          if (!silent) toast('已设为「' + (h.name || '自定义目录') + '」，之后下载直接保存到该文件夹');
          return h;
        });
      });
    }).catch(function () {
      dirDeclinedAt = Date.now();   // 60 秒内不重复弹窗，超时后仍会自动再试
      if (!silent) toast('已取消，仍使用浏览器默认下载位置');
      return null;
    });
  }
  /* 必须在用户点击「导出 / 下载」的手势内调用；download() 会等这个 Promise 完成再写文件 */
  function prepareDownloadDir() {
    if (!fsDirSupported()) return;
    if (dirDeclinedAt) {
      if (Date.now() - dirDeclinedAt < 60000) return;
      dirDeclinedAt = 0;
    }
    if (dirPromise) return;
    if (dirHandle) {
      dirPromise = dirPermission(dirHandle, true).then(function (ok) {
        if (!ok) { dirHandle = null; renderDownloadStatus(); return null; }
        return dirHandle;
      });
      return;
    }
    dirPromise = pickDesktopDir(true).then(function (h) {
      return h;
    });
  }
  function writeToDesktop(h, bytes, name, mime) {
    return h.getFileHandle(name, { create: true }).then(function (fh) {
      return fh.createWritable();
    }).then(function (w) {
      return w.write(new Blob([bytes], { type: mime || 'application/zip' })).then(function () { return w.close(); });
    }).then(function () { return true; });
  }
  function fallbackDownload(bytes, name, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  function download(bytes, filename, mime) {
    var name = sanitize(filename || 'download.zip');
    Promise.resolve(dirPromise || Promise.resolve(dirHandle)).then(function (h) {
      if (!h) return null;
      return dirPermission(h, false).then(function (ok) {
        if (!ok) return null;
        return writeToDesktop(h, bytes, name, mime);
      }).catch(function () { return null; });
    }).then(function (done) {
      if (done) { toast('已保存到' + (dirHandle && dirHandle.name ? '「' + dirHandle.name + '」' : '桌面') + '：' + name); return; }
      fallbackDownload(bytes, name, mime);
      toast('本次保存到浏览器默认位置；点「设置 → 下载位置」可固定为桌面');
    }).catch(function () { fallbackDownload(bytes, name, mime); });
  }
  function resetDownloadDir() {
    dirHandle = null; dirPromise = null; dirDeclinedAt = Date.now();
    setPref(DIR_PREF_KEY, null);
    renderDownloadStatus(); toast('已恢复为浏览器默认下载位置');
  }

  /* ---------- 文件仓库：IndexedDB（不可用则降级内存） ---------- */
  var _db = null, _dbReady = false;
  var memFiles = new Map();
  function openDB() {
    return new Promise(function (resolve) {
      if (_dbReady) return resolve(_db);
      if (!('indexedDB' in window)) { _dbReady = true; return resolve(null); }
      var req;
      try { req = indexedDB.open('cy_web_files', 1); }
      catch (e) { _dbReady = true; return resolve(null); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = function () { _db = req.result; _dbReady = true; resolve(_db); };
      req.onerror = function () { _dbReady = true; resolve(null); };
      setTimeout(function () { if (!_dbReady) { _dbReady = true; resolve(null); } }, 1500);
    });
  }
  function putFile(key, buf) {
    var b = toUint8(buf);
    return openDB().then(function (db) {
      if (!db) { memFiles.set(key, b); return; }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put(b, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { memFiles.set(key, b); resolve(); };
        } catch (e) { memFiles.set(key, b); resolve(); }
      });
    }).then(function () {
      // 共享模式下把文件本体一并送到服务端，其它设备才能预览与导出真实图片
      if (online && online.enabled) shareUpload(key, b).catch(function () { });
    });
  }
  function getFile(key) {
    if (!key) return Promise.resolve(null);
    if (memFiles.has(key)) return Promise.resolve(memFiles.get(key));
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction('files', 'readonly');
          var r = tx.objectStore('files').get(key);
          r.onsuccess = function () { resolve(r.result ? toUint8(r.result) : null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }).then(function (b) {
      if (b || !online || !online.enabled || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) return b;
      // 本机没有（记录来自其它设备）→ 按 key 向共享服务按需取回真实二进制
      return fetch('./api/file?key=' + encodeURIComponent(key), { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.arrayBuffer() : null; })
        .then(function (ab) {
          if (!ab || !ab.byteLength) return null;
          var u = toUint8(ab);
          memFiles.set(key, u);
          return u;
        }).catch(function () { return null; });
    });
  }
  /* 首次连上共享服务时，把本机已有材料补传一次（覆盖演示数据先于连接生成的情况） */
  function shareUpload(key, b) {
    if (!online || !online.enabled || !/^[A-Za-z0-9_-]{1,80}$/.test(key || '')) return Promise.resolve();
    if (!b || b.length > 8 * 1024 * 1024) return Promise.resolve();
    try {
      return apiFetch('./api/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, data: bytesToBase64(b) })
      }).catch(function () { });
    } catch (e) { return Promise.resolve(); }
  }
  function shareExistingFiles() {
    if (!online || !online.enabled) return Promise.resolve();
    var jobs = [];
    state.records.forEach(function (r) {
      Object.keys(r.materials || {}).forEach(function (k) {
        (r.materials[k] || []).forEach(function (f) {
          if (!f.key || !/^[A-Za-z0-9_-]{1,80}$/.test(f.key)) return;
          jobs.push(getFile(f.key).then(function (b) {
            return b ? shareUpload(f.key, b) : null;
          }).catch(function () { }));
        });
      });
    });
    return Promise.all(jobs);
  }
  function delFile(key) {
    memFiles.delete(key);
    return openDB().then(function (db) {
      if (!db) return;
      try { db.transaction('files', 'readwrite').objectStore('files').delete(key); } catch (e) { }
    });
  }
  function fileBuffer(f) {
    if (!f) return Promise.resolve(null);
    if (f._buf) return Promise.resolve(f._buf);
    return getFile(f.key).then(function (b) { if (b) f._buf = b; return b || null; });
  }
  function releaseRecordFiles(r) {
    var jobs = [];
    Object.keys(r.materials || {}).forEach(function (k) {
      (r.materials[k] || []).forEach(function (f) { if (f.key) jobs.push(delFile(f.key)); });
    });
    return Promise.all(jobs);
  }

  /* ---------- 状态与持久化 ---------- */
  var state = { records: [], announcements: [], tombs: {}, user: null, role: null, lastRead: 0 };
  var selected = new Set(), currentId = null, currentTab = 'work', formFiles = {};
  var pgDone = 0, pgTotal = 1, _modalYes = null;
  var _lastIds = { records: null, announcements: null };

  function cleanRec(r) {
    return JSON.parse(JSON.stringify(r, function (k, v) { return k === '_buf' ? undefined : v; }));
  }
  /* 自动墓碑：与上次保存的 id 集合比对，捕捉所有删除入口
   * （删除单据 / 清理过期 / 清空 / 重置 / 导入覆盖），让删除也能跨设备传播。 */
  function noteDeletions() {
    var now = Date.now(), recIds = {}, annIds = {};
    state.records.forEach(function (r) { if (r && r.id != null) recIds[String(r.id)] = 1; });
    state.announcements.forEach(function (a) { if (a && a._id != null) annIds[String(a._id)] = 1; });
    if (!online.applying) {
      ['records', 'announcements'].forEach(function (kind) {
        var prev = _lastIds[kind], cur = kind === 'records' ? recIds : annIds;
        if (!prev) return;
        Object.keys(prev).forEach(function (id) {
          if (!cur[id] && !state.tombs[id]) state.tombs[id] = now;
        });
      });
    }
    _lastIds.records = recIds; _lastIds.announcements = annIds;
  }
  function saveState() {
    noteDeletions();
    try {
      localStorage.setItem(K_STATE, JSON.stringify({
        version: 3,
        records: state.records.map(cleanRec),
        announcements: state.announcements,
        tombs: state.tombs,
        user: state.user, role: state.role, lastRead: state.lastRead
      }));
    } catch (e) { toast('本地存储写入失败：' + (e && e.message ? e.message : '容量不足')); }
    scheduleOnlinePush();
  }
  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(K_STATE); } catch (e) { }
    if (!raw) return false;
    try {
      var s = JSON.parse(raw);
      state.records = Array.isArray(s.records) ? s.records : [];
      state.announcements = Array.isArray(s.announcements) ? s.announcements : [];
      state.tombs = (s.tombs && typeof s.tombs === 'object') ? s.tombs : {};
      state.user = s.user || null;
      state.role = s.role || null;
      state.lastRead = Number(s.lastRead) || 0;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 权限密钥：前端仅保存摘要，界面与源码均不出现明文 ---------- */
  var KEY_HASH = {
    admin: '183f972c7a85d68def4902d437b355c4789698ed5bf8d9d9806b65d9caa59ef7',
    audit: 'e2cc1194785e6353b454b81a6c5fe21957fe080c7c9048703831c3201137cf77'
  };
  /* 同步 SHA-256（纯 JS，file:// 下也可用）：把输入与本地摘要比对，避免明文落盘 */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function rotr32(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(msg) {
    var raw = unescape(encodeURIComponent(String(msg || ''))), bytes = [], i, t;
    for (i = 0; i < raw.length; i++) bytes.push(raw.charCodeAt(i) & 255);
    var bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(0, 0, 0, 0);
    bytes.push((bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (var off = 0; off < bytes.length; off += 64) {
      var w = new Array(64);
      for (t = 0; t < 16; t++) {
        w[t] = ((bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) |
                (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }
  function keyRole(input) {
    var h = sha256(String(input || '').trim());
    if (h === KEY_HASH.admin) return 'admin';
    if (h === KEY_HASH.audit) return 'audit';
    return null;
  }

  /* ---------- 演示数据清理：一次性移除历史遗留的演示单据 / 公告 ---------- */
  var DEMO_REC_IDS = {
    R20261028001: 1, R20261101002: 1, R20261102003: 1,
    R20261103004: 1, R20261104005: 1, R20261105006: 1
  };
  function isDemoRec(r) {
    if (!r) return false;
    if (DEMO_REC_IDS[String(r.id)]) return true;
    var mats = r.materials || {};
    return Object.keys(mats).some(function (k) {
      return (mats[k] || []).some(function (f) {
        return f && String(f.fileID || '').indexOf('demo://') === 0;
      });
    });
  }
  function isDemoAnn(a) { return !!a && /^A_DEMO_/.test(String(a._id || '')); }
  /* 返回是否清理了内容；调用方负责 saveState()，墓碑会把删除同步到其它设备 */
  function stripDemoData() {
    var removed = [], now = Date.now();
    state.records = state.records.filter(function (r) {
      if (isDemoRec(r)) { removed.push(String(r.id)); return false; }
      return true;
    });
    state.announcements = state.announcements.filter(function (a) {
      if (isDemoAnn(a)) { removed.push(String(a._id)); return false; }
      return true;
    });
    if (!removed.length) return false;
    removed.forEach(function (id) { state.tombs[id] = now; });
    selected.clear();
    return true;
  }

  /* ---------- 筛选 ---------- */  /* ---------- 筛选 ---------- */
  function workFiltered() {
    var q = ($('wSearch').value || '').trim().toLowerCase();
    var st = $('wStage').value, ty = $('wType').value;
    return state.records.filter(function (r) {
      if (st !== '' && String(r.stage) !== st) return false;
      if (ty !== '' && r.type !== ty) return false;
      if (!q) return true;
      return [r.reason, r.name, r.id, r.dept, r.academy].join(' ').toLowerCase().includes(q);
    });
  }
  function histFiltered() {
    var q = ($('hSearch').value || '').trim().toLowerCase(), f = $('hFilter').value;
    return state.records.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).filter(function (r) {
      if (f === 'ing' && (r.rejected || r.stage >= 4)) return false;
      if (f === 'done' && (r.rejected || r.stage < 4)) return false;
      if (f === 'rej' && !r.rejected) return false;
      if (q) {
        var hay = [r.id, r.name, r.reason, r.type, r.academy, r.dept, r.payMethod].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function auditFiltered() {
    var f = $('aFilter').value;
    return state.records.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).filter(function (r) {
      if (f === 'ing') return !r.rejected && r.stage < 4;
      if (f === 'done') return !r.rejected && r.stage >= 4;
      if (f === 'rej') return !!r.rejected;
      return true;
    });
  }
  function currentExportList() {
    if (currentTab === 'work') return workFiltered();
    if (currentTab === 'history') return histFiltered();
    if (currentTab === 'audit') return auditFiltered();
    return state.records.slice();
  }
  function trackList() {
    var u = state.user ? state.user.username : '';
    return state.records.filter(function (r) { return (r.userId || r.name || '') === u; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /* ---------- 渲染 ---------- */
  function statHtml(k, v, c) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v ' + (c || '') + '">' + esc(v) + '</div></div>';
  }
  function workStatsHtml(list) {
    var total = list.reduce(function (n, r) { return n + (Number(r.total) || 0); }, 0);
    return statHtml('单据总数', String(list.length)) +
      statHtml('报销总额', fmtMoney(total), 'c') +
      statHtml('流转中', String(list.filter(function (r) { return !r.rejected && r.stage < 4; }).length)) +
      statHtml('已完成', String(list.filter(function (r) { return !r.rejected && r.stage >= 4; }).length));
  }
  function histStatsHtml(list) {
    var total = list.reduce(function (n, r) { return n + (Number(r.total) || 0); }, 0);
    return statHtml('全部单据', String(list.length)) +
      statHtml('报销总额', fmtMoney(total), 'c') +
      statHtml('已完成', String(list.filter(function (r) { return !r.rejected && r.stage >= 4; }).length)) +
      statHtml('已退回', String(list.filter(function (r) { return !!r.rejected; }).length));
  }
  function auditStatsHtml(list) {
    return statHtml('审核中', String(list.filter(function (r) { return !r.rejected && r.stage >= 1; }).length)) +
      statHtml('已签字', String(list.filter(function (r) { return !r.rejected && r.stage >= 2; }).length)) +
      statHtml('计财处', String(list.filter(function (r) { return !r.rejected && r.stage >= 3; }).length)) +
      statHtml('已完成', String(list.filter(function (r) { return !r.rejected && r.stage >= 4; }).length), 'c');
  }
  function rowHtml(r, opts) {
    var o = opts || {}, h = '<tr data-id="' + esc(r.id) + '">';
    if (o.checkbox) h += '<td class="c-check" data-label="选择"><input type="checkbox" class="rowchk" data-id="' + esc(r.id) + '" ' + (selected.has(r.id) ? 'checked' : '') + '></td>';
    h += '<td data-label="报销事由"><div>' + esc(r.reason) + '</div><div class="t-sub">' + esc(r.id) + '</div></td>' +
      '<td data-label="提交人"><div>' + esc(r.name) + '</div><div class="t-sub">' + esc(r.dept || '—') + '</div></td>' +
      '<td data-label="类型">' + esc(r.type || '—') + '</td>' +
      '<td data-label="金额"><span class="money">' + fmtMoney(r.total) + '</span></td>' +
      '<td data-label="阶段">' + stageTag(r) + '</td>' +
      '<td data-label="材料">' + countMats(r) + ' 份</td>';
    if (o.showTime) h += '<td data-label="提交时间">' + fmtDate(r.createdAt) + '</td>';
    h += '<td class="c-act" data-label="操作">' +
      '<button class="btn primary sm" data-act="open" data-id="' + esc(r.id) + '">详情</button> ' +
      '<button class="btn ghost sm" data-act="exp1" data-id="' + esc(r.id) + '">导出</button></td></tr>';
    return h;
  }
  function recCardHtml(r) {
    var filled = r.rejected ? 0 : (Number(r.stage) || 0);
    var segs = STAGES.slice(0, 4).map(function (s, i) {
      return '<div class="seg ' + (i < filled ? (r.rejected ? 'rj' : 'on') : '') + '"></div>';
    }).join('');
    return '<div class="rec-card" data-act="open" data-id="' + esc(r.id) + '">' +
      '<div class="rc-hd"><div><div class="rc-t">' + esc(r.reason) + '</div>' +
      '<div class="rc-m">' + esc(r.id) + ' · ' + esc(r.type) + ' · ' + fmtMoney(r.total) + ' · ' + fmtDate(r.createdAt) + '</div></div>' + stageTag(r) + '</div>' +
      (r.rejected ? '<div class="rej" style="margin-top:10px">退回原因：' + esc(r.rejectReason || '未填写') + '</div>' : '') +
      '<div class="segs">' + segs + '</div></div>';
  }
  function renderHeader() {
    var b = $('roleBadge');
    if (isAdmin()) { b.textContent = '最高管理'; b.className = 'badge ok'; }
    else if (state.role === 'audit') { b.textContent = '审核员'; b.className = 'badge info'; }
    else { b.textContent = state.user ? '已登记' : '游客'; b.className = 'badge'; }
    $('userBtn').textContent = state.user ? (state.user.username + ' · 切换') : '身份登记';
  }
  function unreadCount() {
    var lr = state.lastRead || 0;
    return state.announcements.filter(function (a) { return (a.updatedAt || a.createdAt || 0) > lr; }).length;
  }
  function renderBadges() { $('annDot').hidden = unreadCount() === 0; }
  function renderWork() {
    var rows = workFiltered();
    $('workStats').innerHTML = workStatsHtml(state.records);
    $('workTbody').innerHTML = rows.map(function (r) { return rowHtml(r, { checkbox: true, showTime: true }); }).join('');
    $('workEmpty').hidden = rows.length > 0;
    $('wSelCount').textContent = '已选 ' + selected.size + ' 条';
    var vis = rows.filter(function (r) { return selected.has(r.id); }).length;
    $('wSelectAll').checked = rows.length > 0 && vis === rows.length;
    $('wSelectAll').indeterminate = vis > 0 && vis < rows.length;
  }
  function renderSubmit() {
    var list = trackList();
    $('mySubmitList').innerHTML = list.length ? list.slice(0, 8).map(function (r) {
      return '<div class="rec-card" data-act="open" data-id="' + esc(r.id) + '">' +
        '<div class="rc-hd"><div class="rc-t">' + esc(r.reason) + '</div>' + stageTag(r) + '</div>' +
        '<div class="rc-m">' + fmtMoney(r.total) + ' · ' + fmtDate(r.createdAt) + '</div></div>';
    }).join('') : '<div class="hint">暂无提交记录，填写左侧表单后即可创建。</div>';
  }
  function renderTrack() {
    var list = trackList();
    $('trackSub').textContent = state.user
      ? ('当前身份：' + state.user.username + ' · 共 ' + list.length + ' 条单据')
      : '尚未登记身份，请先点击右上角「身份登记」。';
    $('trackList').innerHTML = list.map(recCardHtml).join('');
    $('trackEmpty').textContent = state.user ? '暂无单据，请先到「提交报销」创建。' : '请先点击右上角「身份登记」后再查看进度。';
    $('trackEmpty').hidden = list.length > 0;
  }
  function renderHistory() {
    var ok = isAdmin();
    $('historyLock').hidden = ok;
    $('historyBody').hidden = !ok;
    if (!ok) return;
    var all = state.records.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var rows = histFiltered();
    $('histStats').innerHTML = histStatsHtml(all);
    $('histTbody').innerHTML = rows.map(function (r) { return rowHtml(r, { checkbox: false, showTime: true }); }).join('');
    $('histEmpty').hidden = rows.length > 0;
  }
  function renderAudit() {
    var ok = isAuditor();
    $('auditLock').hidden = ok;
    $('auditBody').hidden = !ok;
    if (!ok) return;
    $('aRoleTag').textContent = isAdmin() ? '最高管理' : '审核员';
    $('aStats').innerHTML = auditStatsHtml(state.records);
    var rows = auditFiltered();
    $('auditTbody').innerHTML = rows.map(function (r) { return rowHtml(r, { checkbox: false, showTime: false }); }).join('');
    $('auditEmpty').hidden = rows.length > 0;
  }
  function renderAnnounce() {
    var lr = state.lastRead || 0, admin = isAdmin();
    var list = state.announcements.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    $('announceList').innerHTML = list.map(function (a) {
      var unread = (a.updatedAt || a.createdAt || 0) > lr;
      return '<div class="ann-item ' + (unread ? 'unread' : '') + '">' +
        '<div class="ann-hd"><div class="ann-title">' + (a.pinned ? '<span class="pin">📌 置顶</span>' : '') +
        esc(a.title) + (unread ? '<span class="new">未读</span>' : '') + '</div>' +
        '<div class="ann-meta">' + esc(fmtTime(a.updatedAt || a.createdAt)) + '</div></div>' +
        (a.content ? '<div class="ann-body">' + esc(a.content) + '</div>' : '') +
        (admin ? '<div class="ann-ops"><button class="btn ghost sm" data-act="annEdit" data-id="' + esc(a._id) + '">编辑</button>' +
          '<button class="btn danger sm" data-act="annDel" data-id="' + esc(a._id) + '">删除</button></div>' : '') +
        '</div>';
    }).join('');
    $('annEmpty').hidden = list.length > 0;
    var btn = document.querySelector('[data-act="annAdd"]');
    if (btn) btn.textContent = admin ? '发布公告' : '发布公告（需最高管理）';
  }
  function renderData() {
    var files = 0, size = 0;
    state.records.forEach(function (r) {
      Object.keys(r.materials || {}).forEach(function (k) {
        (r.materials[k] || []).forEach(function (f) { files++; size += Number(f.size) || 0; });
      });
    });
    var storeLine = online.enabled
      ? '在线共享：单据、公告与材料原始文件存于本站服务端，多端自动同步；身份 / 角色 / 密钥 / 未读状态仍只存本机。'
      : '存储：localStorage（元数据）+ IndexedDB（文件本体）· 数据不会自动上传任何服务器。';
    $('storeInfo').innerHTML = '单据 ' + state.records.length + ' 条 · 公告 ' + state.announcements.length +
      ' 条 · 材料 ' + files + ' 份（约 ' + (size / 1024 / 1024).toFixed(2) + ' MB）<br>' + storeLine;
    renderAdminRecords();
  }

  /* ---------- 最高管理：删除项目（单据 + 材料 + 跨设备墓碑） ---------- */
  var adminSelected = new Set();
  function unlockDataAdmin() {
    var key = (($('dataAdminKey').value) || '').trim();
    if (keyRole(key) !== 'admin') { toast('密钥错误，仅最高管理可删除项目'); return; }
    state.role = 'admin'; $('dataAdminKey').value = '';
    saveState(); renderAll(); toast('已解锁最高管理：可删除项目');
  }
  function dataRoleLogout() { state.role = null; saveState(); renderAll(); toast('已退出最高管理'); }
  function renderAdminRecords() {
    var box = $('adminRecList'), st = $('dataAdminStatus'), ops = $('adminRecOps'), row = $('adminUnlockRow');
    if (!box) return;
    if (!isAdmin()) {
      st.textContent = '当前角色：' + (state.role === 'audit' ? '审核员' : '普通用户') + ' · 删除项目需最高管理密钥。';
      box.innerHTML = '<div class="empty" style="padding:18px">解锁后可在下方查看并删除项目</div>';
      ops.hidden = true; row.hidden = false; return;
    }
    row.hidden = true;
    var ids = {}; state.records.forEach(function (r) { ids[r.id] = 1; });
    Array.from(adminSelected).forEach(function (id) { if (!ids[id]) adminSelected.delete(id); });
    st.textContent = '当前角色：最高管理 · 共 ' + state.records.length + ' 个项目，可单条或批量删除（不可恢复，会同步删除其它设备上的这些项目）。';
    ops.hidden = !state.records.length || !adminSelected.size;
    if (!state.records.length) { box.innerHTML = '<div class="empty" style="padding:18px">暂无项目</div>'; return; }
    box.innerHTML = state.records.slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    }).map(function (r) {
      return '<div class="admin-rec"><label class="ar-chk"><input type="checkbox" class="adchck" data-id="' +
        esc(r.id) + '"' + (adminSelected.has(r.id) ? ' checked' : '') + '> 选择</label>' +
        '<div class="ar-main">' + esc(r.reason || '（未填写事由）') +
        '<div class="ar-sub">' + esc(r.id) + ' · ' + esc(r.name || '—') + ' · ' + esc(fmtMoney(r.total)) +
        ' · ' + esc(stageLabel(r)) + ' · ' + esc(fmtDate(r.createdAt)) + '</div></div>' +
        '<button class="btn danger sm" data-act="deleteAdminRec" data-id="' + esc(r.id) + '">删除项目</button></div>';
    }).join('');
  }
  function doDeleteRecords(list, label) {
    if (!isAdmin()) { toast('仅最高管理可删除项目'); return; }
    if (!list.length) { toast('请先选择要删除的项目'); return; }
    confirmDialog('删除项目（最高管理）',
      '确认永久删除 ' + list.length + ' 个项目及其全部材料？' + label +
      ' 此操作不可恢复，且会同步删除其它设备上的这些项目。', function () {
        Promise.all(list.map(releaseRecordFiles)).then(function () {
          var ids = {}; list.forEach(function (r) { ids[r.id] = 1; });
          state.records = state.records.filter(function (r) { return !ids[r.id]; });
          list.forEach(function (r) { selected.delete(r.id); adminSelected.delete(r.id); });
          if (currentId && ids[currentId]) closeDrawer();
          saveState(); renderAll(); toast('已删除 ' + list.length + ' 个项目');
        }).catch(function (e) { toast('删除失败：' + (e && e.message ? e.message : '未知错误')); });
      });
  }
  function deleteAdminRec(id) {
    var r = state.records.find(function (x) { return x.id === id; });
    if (r) doDeleteRecords([r], '《' + (r.reason || r.id) + '》');
  }
  function deleteAdminSelected() {
    doDeleteRecords(state.records.filter(function (r) { return adminSelected.has(r.id); }), '批量选中项目');
  }

  /* ============================================================
   * 客服反馈：用户提交 / 客服凭密钥查看（密钥只在服务端校验，前端零明文）
   * ============================================================ */
  var K_FB_MINE = 'cy_web_my_feedback';
  var service = { on: false, key: '', items: [] };
  function apiPostTo(p, body) {
    return apiFetch(p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  function myFeedback() {
    try { return JSON.parse(localStorage.getItem(K_FB_MINE) || '[]') || []; } catch (e) { return []; }
  }
  function svcView(id) {
    ['serviceUserView', 'serviceUnlockView', 'serviceAdminView'].forEach(function (k) {
      if ($(k)) $(k).hidden = k !== id;
    });
  }
  function serviceUnlockOpen() { if ($('svcKey')) $('svcKey').value = ''; svcView('serviceUnlockView'); }
  function serviceLogout() {
    service.on = false; service.key = ''; service.items = [];
    svcView('serviceUserView'); renderService();
  }
  function feedbackLoad() {
    return apiPostTo('./api/feedback', { action: 'list', key: service.key })
      .then(function (j) { service.items = j.items || []; });
  }
  function serviceUnlock() {
    if (!online.enabled) { toast('客服端需在在线共享链接下使用'); return; }
    var key = (($('svcKey').value || '').trim());
    if (!key) { toast('请输入客服密钥'); return; }
    service.key = key;
    return feedbackLoad().then(function () {
      service.on = true; $('svcKey').value = '';
      svcView('serviceAdminView'); renderService(); toast('已进入客服工作台');
    }).catch(function (e) { service.key = ''; toast('客服校验失败：' + e.message); });
  }
  function fbSubmit() {
    if (!online.enabled) { toast('提交反馈需在在线共享链接下使用'); return; }
    var text = (($('fbText').value || '').trim());
    if (!text) { toast('请填写反馈内容'); return; }
    return apiPostTo('./api/feedback', {
      action: 'submit', text: text,
      contact: (($('fbContact').value || '').trim()),
      from: (state.user && state.user.username) || '匿名'
    }).then(function (j) {
      $('fbText').value = ''; $('fbContact').value = '';
      var a = myFeedback(); a.push(j.item);
      try { localStorage.setItem(K_FB_MINE, JSON.stringify(a.slice(-20))); } catch (e) { }
      renderService(); toast('反馈已提交，感谢你的意见');
    }).catch(function (e) { toast('提交失败：' + e.message); });
  }
  function fbStatus(id, status) {
    apiPostTo('./api/feedback', { action: 'status', key: service.key, id: id, status: status })
      .then(feedbackLoad).then(renderService)
      .catch(function (e) { toast('操作失败：' + e.message); });
  }
  function renderService() {
    var mine = $('fbMine');
    if (mine) {
      var a = myFeedback().slice(-3).reverse();
      mine.innerHTML = a.length ? '<b>我最近提交的反馈</b><br>' + a.map(function (x) {
        return esc(fmtTime(x.at)) + ' · ' + esc(String(x.text || '').slice(0, 60));
      }).join('<br>') : '';
    }
    if (!service.on || !$('fbList')) return;
    $('svcCount').textContent = '共 ' + service.items.length + ' 条 · 待处理 ' +
      service.items.filter(function (x) { return x.status !== 'done'; }).length + ' 条';
    $('fbList').innerHTML = service.items.length ? service.items.slice().reverse().map(function (x) {
      var done = x.status === 'done';
      return '<div class="fb-item ' + (done ? 'done' : '') + '">' +
        '<div class="fb-hd"><span>' + esc(x.from || '匿名') +
        (x.contact ? ' · ' + esc(x.contact) : '') + '</span><span>' + esc(fmtTime(x.at)) + '</span></div>' +
        '<div class="fb-body">' + esc(x.text) + '</div>' +
        '<div class="fb-foot"><span class="tag ' + (done ? 's4' : 's1') + '">' +
        (done ? '已处理' : '待处理') + '</span>' +
        '<button class="btn ghost sm" data-act="fbStatus" data-id="' + esc(x.id) + '" data-status="' +
        (done ? 'open' : 'done') + '">' + (done ? '重新打开' : '标记已处理') + '</button></div></div>';
    }).join('') : '<div class="empty">暂无反馈</div>';
  }

  /* ============================================================
   * 项目组会议：四位房间号、0000 长期保留、关闭后号码回池、文字与文件实时同步
   * ============================================================ */
  var K_ROOM = 'cy_web_room_session', K_CID = 'cy_web_client_id', ROOM_UI_MAX = 120;
  var room = { no: '', owner: '', seq: 0, msgs: [], timer: null, busy: false };
  function clientId() {
    var v = '';
    try { v = localStorage.getItem(K_CID) || ''; } catch (e) { }
    if (!v) {
      v = 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(K_CID, v); } catch (e) { }
    }
    return v;
  }
  function roomSave() {
    try {
      localStorage.setItem(K_ROOM, JSON.stringify({
        no: room.no, owner: room.owner, seq: room.seq, msgs: room.msgs.slice(-ROOM_UI_MAX)
      }));
    } catch (e) { }
  }
  function roomRestore() {
    try {
      var j = JSON.parse(localStorage.getItem(K_ROOM) || 'null');
      if (j && /^\d{4}$/.test(j.no)) {
        room.no = j.no; room.owner = j.owner || '';
        room.seq = Number(j.seq) || 0;
        room.msgs = Array.isArray(j.msgs) ? j.msgs.slice(-ROOM_UI_MAX) : [];
      }
    } catch (e) { }
  }
  function roomCall(body) { return apiPostTo('./api/room', body); }
  function roomStopPoll() { if (room.timer) { clearInterval(room.timer); room.timer = null; } }
  function roomStartPoll() {
    roomStopPoll();
    if (!room.no || !online.enabled) return;
    room.timer = setInterval(function () {
      if (currentTab === 'room' && !room.busy) roomPull();
    }, 2000);
  }
  function roomLeave() {
    room.no = ''; room.owner = ''; room.seq = 0; room.msgs = [];
    try { localStorage.removeItem(K_ROOM); } catch (e) { }
    roomStopPoll(); renderRoom();
  }
  function roomPull() {
    if (!room.no || room.busy || !online.enabled) return;
    room.busy = true;
    roomCall({ action: 'pull', no: room.no, since: room.seq }).then(function (j) {
      room.busy = false;
      if (!room.no) return;
      if (j.messages && j.messages.length) {
        room.msgs = room.msgs.concat(j.messages).slice(-ROOM_UI_MAX);
        room.seq = Math.max(room.seq, Number(j.seq) || 0);
        roomSave(); renderRoomMsgs();
      }
    }).catch(function (e) {
      room.busy = false;
      if (/不存在|已结束/.test(e.message || '')) { roomLeave(); toast('会议已结束，房间号已回收'); }
    });
  }
  function roomCreate(mode) {
    if (!online.enabled) { toast('项目组会议需在在线共享链接下使用'); return; }
    var no = mode === 'random' ? '' : (($('roomCreateNo').value || '').trim());
    if (mode !== 'random' && !/^\d{4}$/.test(no)) { toast('请输入 4 位数字房间号'); return; }
    return roomCall({ action: 'create', mode: mode, no: no, owner: clientId() }).then(function (j) {
      $('roomCreateNo').value = '';
      room.no = j.room.no; room.owner = clientId();
      room.seq = Number(j.room.seq) || 0; room.msgs = [];
      roomSave(); renderRoom(); roomStartPoll();
      toast('会议已创建，房间号 ' + j.room.no + '，可复制发给成员');
    }).catch(function (e) { toast('创建失败：' + e.message); });
  }
  function roomJoin(prefill) {
    if (!online.enabled) { toast('项目组会议需在在线共享链接下使用'); return; }
    var no = String(prefill != null ? prefill : (($('roomJoinNo').value || '').trim()));
    if (!/^\d{4}$/.test(no)) { toast('请输入 4 位数字房间号'); return; }
    roomCall({ action: 'join', no: no }).then(function (j) {
      room.no = j.room.no;
      room.owner = (j.room.owner && j.room.owner === clientId()) ? clientId() : '';
      room.seq = Number(j.room.seq) || 0;
      room.msgs = (j.room.messages || []).slice(-ROOM_UI_MAX);
      roomSave(); renderRoom(); roomStartPoll();
      toast('已加入房间 ' + no);
    }).catch(function (e) { toast('加入失败：' + e.message); });
  }
  function roomClose() {
    if (!room.no) return;
    if (room.no === '0000') { toast('0000 为长期房间，不能关闭'); return; }
    if (!room.owner) { toast('仅会议发起人可关闭房间'); return; }
    confirmDialog('关闭会议', '关闭后房间 ' + room.no + ' 会立即释放，号码回到可分配池。', function () {
      roomCall({ action: 'close', no: room.no, owner: clientId() }).then(function () {
        var n = room.no; roomLeave(); toast('会议 ' + n + ' 已关闭，号码已回收');
      }).catch(function (e) { toast('关闭失败：' + e.message); });
    });
  }
  function roomSend() {
    if (!room.no || !online.enabled) return;
    var el = $('roomText'), text = (el.value || '').trim();
    if (!text) return;
    el.value = '';
    return roomCall({
      action: 'send', no: room.no, from: (state.user && state.user.username) || '成员',
      cid: clientId(), type: 'text', text: text
    }).then(function (j) {
      room.msgs.push(j.message);
      room.seq = Math.max(room.seq, Number(j.message.seq) || 0);
      room.msgs = room.msgs.slice(-ROOM_UI_MAX);
      roomSave(); renderRoomMsgs();
    }).catch(function (e) { el.value = text; toast('发送失败：' + e.message); });
  }
  function roomSendFile(file) {
    if (!file || !room.no || !online.enabled) return;
    if (file.size > 8 * 1024 * 1024) { toast('单个文件不能超过 8 MB'); return; }
    file.arrayBuffer().then(function (buf) {
      var key = 'rm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      return fetch('./api/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, data: bytesToBase64(new Uint8Array(buf)) })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) throw new Error(j.msg || '文件写入失败');
        return roomCall({
          action: 'send', no: room.no, from: (state.user && state.user.username) || '成员',
          cid: clientId(), type: 'file', key: key, name: file.name, size: file.size
        });
      });
    }).then(function (j) {
      room.msgs.push(j.message);
      room.seq = Math.max(room.seq, Number(j.message.seq) || 0);
      room.msgs = room.msgs.slice(-ROOM_UI_MAX);
      roomSave(); renderRoomMsgs(); toast('文件已发送到会议');
    }).catch(function (e) { toast('文件发送失败：' + e.message); });
  }
  function roomDownload(key, name) {
    fetch('./api/file?key=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) { download(new Uint8Array(buf), name || '会议文件', 'application/octet-stream'); })
      .catch(function (e) { toast('下载失败：' + e.message); });
  }
  function roomCopy() {
    var n = room.no;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(n).then(function () { toast('房间号 ' + n + ' 已复制'); })
        .catch(function () { toast('房间号：' + n); });
    } else { toast('房间号：' + n); }
  }
  function renderRoomMsgs() {
    var box = $('roomMsgs'); if (!box) return;
    var cid = clientId();
    box.innerHTML = room.msgs.length ? room.msgs.map(function (m) {
      var me = m.cid && m.cid === cid;
      var body = m.type === 'file'
        ? '<span class="filelink" data-act="roomDownload" data-key="' + esc(m.file.key) +
          '" data-name="' + esc(m.file.name) + '">📎 ' + esc(m.file.name) + '（' +
          Math.round((Number(m.file.size) || 0) / 1024) + ' KB）</span>'
        : esc(m.text);
      return '<div class="rmsg ' + (me ? 'me' : '') + '"><div class="bubble">' + body + '</div>' +
        '<div class="meta">' + esc(m.from || '成员') + ' · ' + esc(fmtTime(m.at)) + '</div></div>';
    }).join('') : '<div class="empty">还没有消息，发一条开始同步进度吧</div>';
    box.scrollTop = box.scrollHeight;
  }
  function renderRoomView() {
    var lobby = $('roomLobby'), meeting = $('roomMeeting');
    if (!lobby || !meeting) return;
    lobby.hidden = !!room.no; meeting.hidden = !room.no;
    if (!room.no) {
      if (!online.enabled && $('roomFreeHint')) {
        $('roomFreeHint').textContent = '当前为离线模式：项目组会议需在在线共享链接下使用。';
      }
      return;
    }
    $('roomMeetingNo').textContent = room.no;
    $('roomMeetingSub').textContent = room.no === '0000'
      ? '长期房间 · 任何人可随时加入 · 消息实时同步'
      : (room.owner ? '我是发起人 · 可关闭会议释放号码' : '成员 · 消息实时同步');
    if ($('roomCloseBtn')) $('roomCloseBtn').hidden = (room.no === '0000' || !room.owner);
    renderRoomMsgs();
  }
  function roomList() {
    if (!online.enabled) return;
    roomCall({ action: 'list' }).then(function (j) {
      if ($('roomFreeHint')) {
        $('roomFreeHint').textContent = '剩余可分配号码 ' + j.free + ' 个 · 0000 为长期保留房间';
      }
      var arr = (j.rooms || []).slice(0, 40);
      if ($('roomActiveList')) {
        $('roomActiveList').innerHTML = arr.length ? arr.map(function (r) {
          return '<button class="room-pill" data-act="roomJoin" data-id="' + esc(r.no) + '">' +
            esc(r.no) + (r.permanent ? ' · 长期' : '') + '</button>';
        }).join('') : '<div class="hint">暂无进行中的会议</div>';
      }
    }).catch(function () { });
  }
  function renderRoom() { renderRoomView(); if (!room.no) roomList(); }

  function renderAll() {
    renderHeader(); renderWork(); renderSubmit(); renderTrack();
    renderHistory(); renderAudit(); renderAnnounce(); renderData(); renderBadges();
    renderRoomView(); renderService();
  }

  function switchTab(tab) {
    if (currentTab === 'announce' && tab !== 'announce') {
      state.lastRead = Date.now(); saveState();
    }
    currentTab = tab;
    document.querySelectorAll('.page').forEach(function (p) { p.hidden = true; });
    var p = $('page-' + tab); if (p) p.hidden = false;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    renderAll();
    if (tab === 'room') { roomList(); roomStartPoll(); } else roomStopPoll();
    if (tab === 'service' && service.on) feedbackLoad().then(renderService).catch(function () { });
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }

  /* ---------- 详情抽屉 ---------- */
  function openDrawer(id, mode) {
    var r = state.records.find(function (x) { return x.id === id; });
    if (!r) return;
    currentId = id;
    var m = mode || (currentTab === 'audit' ? 'audit' : 'track');
    $('dTitle').textContent = r.reason || '单据详情';
    var kv = [
      ['单据编号', r.id], ['报销事由', r.reason], ['报销类型', r.type], ['报销金额', fmtMoney(r.total)],
      ['提交人', r.name], ['书院', r.academy || '—'], ['部门', r.dept || '—'], ['付款方式', r.payMethod || '—'],
      ['当前阶段', stageLabel(r)], ['提交时间', fmtDate(r.createdAt)], ['备注', r.note || '—']
    ];
    var html = '<div class="sec"><h3>基本信息</h3><div class="kv">' + kv.map(function (x) {
      return '<div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + '</div>';
    }).join('') + '</div></div>';
    if (r.rejected) {
      html += '<div class="sec"><h3>退回原因</h3><div class="rej">' + esc(r.rejectReason || '未填写') +
        '</div><div class="t-sub" style="margin-top:6px">' + esc(fmtTime(r.rejectAt)) + ' · ' + esc(r.rejectBy || '审核员') + '</div></div>';
    }
    if (r.rejectLog && r.rejectLog.length) {
      html += '<div class="sec"><h3>历史退回记录</h3>' + r.rejectLog.map(function (x) {
        return '<div class="rej" style="margin-bottom:6px">' + esc(x.reason) + '<div class="t-sub">' + esc(fmtTime(x.at)) + ' · ' + esc(x.by || '') + '</div></div>';
      }).join('') + '</div>';
    }
    html += '<div class="sec"><h3>流程时间线</h3><ul class="tl">' + STAGES.map(function (s) {
      var on = !r.rejected && Number(r.stage) >= s.k, cur = !r.rejected && Number(r.stage) === s.k;
      var t = (r.stageLog && r.stageLog[s.k]) ? fmtTime(r.stageLog[s.k]) : '';
      return '<li class="' + (on ? 'on ' : '') + (cur ? 'cur' : '') + '"><span class="dot"></span><div>' +
        '<div class="tx">' + esc(s.name) + '</div><div class="tm">' + esc(t || '—') + '</div></div></li>';
    }).join('') + '</ul></div>';
    html += '<div class="sec"><h3>材料清单（' + countMats(r) + ' 份 / 上限 ' + MAX_FILES + '）· 点击可直接查看</h3>';
    var keys = Object.keys(r.materials || {});
    if (!keys.length) html += '<div class="empty">暂无材料</div>';
    keys.forEach(function (k) {
      var list = r.materials[k] || [];
      if (!list.length) return;
      html += '<div class="mat-sec"><div class="mat-sec-hd">' + esc(MATNAME[k] || k) +
        '<span class="mat-sec-n">' + list.length + ' 份</span></div><div class="mat-grid">';
      list.forEach(function (f, i) {
        var sz = f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : '—';
        html += '<button type="button" class="mat-card" data-act="viewMat" data-k="' + esc(k) + '" data-i="' + i + '">' +
          '<span class="mat-thumb" data-thumb="' + esc(k) + ':' + i + '"><span class="mat-loading">…</span></span>' +
          '<span class="mat-name">' + esc(f.name || (MATNAME[k] || k)) + '</span>' +
          '<span class="mat-meta">' + esc((f.ext || 'bin').toUpperCase() + ' · ' + sz) + '</span>' +
          '</button>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    $('drawerBody').innerHTML = html;
    loadThumbs(r);
    var bar = $('drawerAuditBar');
    if (m === 'audit' && isAuditor()) {
      bar.hidden = false;
      bar.innerHTML = '<h4>流程操作（点击阶段节点推进 / 回退）</h4><div class="stage-btns">' +
        STAGES.map(function (s) {
          return '<button class="btn ' + (Number(r.stage) === s.k && !r.rejected ? 'primary' : 'ghost') + ' sm" data-act="toggleStage" data-k="' + s.k + '">' + esc(s.name) + '</button>';
        }).join('') + '</div><h4>审核处理</h4><div class="stage-btns">' +
        '<button class="btn amber sm" data-act="rejectOpen">退回申请</button>' +
        (isAdmin() ? '<button class="btn danger sm" data-act="deleteRec">删除单据</button>' : '') +
        '<button class="btn primary sm" data-act="exp1">一键导出</button></div>';
    } else { bar.hidden = true; bar.innerHTML = ''; }
    $('mask').hidden = false; $('drawer').hidden = false;
  }
  /* ---------- 材料直接预览：缩略图 + 原文件查看 ---------- */
  var thumbUrls = [];
  function clearThumbs() {
    thumbUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { } });
    thumbUrls = [];
  }
  function loadThumbs(r) {
    if (!r) return;
    clearThumbs();
    Object.keys(r.materials || {}).forEach(function (k) {
      (r.materials[k] || []).forEach(function (f, i) {
        var box = document.querySelector('[data-thumb="' + k + ':' + i + '"]');
        if (!box) return;
        fileBuffer(f).then(function (buf) {
          if (!buf) { box.innerHTML = '<span class="mat-ph">无本体</span>'; return; }
          var t = fileType(f, buf);
          if (t.image) {
            var url = URL.createObjectURL(new Blob([buf], { type: t.mime }));
            thumbUrls.push(url);
            box.innerHTML = '<img src="' + url + '" alt="' + esc(f.name || '材料') + '" loading="lazy">';
          } else {
            box.innerHTML = '<span class="mat-ph">' + esc((t.ext || 'FILE').toUpperCase()) + '</span>';
          }
        }).catch(function () { box.innerHTML = '<span class="mat-ph">读取失败</span>'; });
      });
    });
  }
  function viewMat(k, i) {
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r) { toast('请先打开一条单据'); return Promise.resolve(); }
    var f = ((r.materials && r.materials[k]) || [])[i];
    if (!f) return Promise.resolve();
    return fileBuffer(f).then(function (buf) {
      if (!buf) { toast('该材料暂无文件本体，可在下方「添加本地材料」补充'); return; }
      var t = fileType(f, buf);
      var url = URL.createObjectURL(new Blob([buf], { type: t.mime }));
      thumbUrls.push(url);
      var title = (MATNAME[k] || k) + ' · ' + (f.name || '材料');
      var meta = '<p class="hint">' + esc(t.ext.toUpperCase() + ' · ' + t.mime) + ' · ' +
        Math.max(1, Math.round(buf.length / 1024)) + ' KB · 原始文件，未转码</p>';
      var body;
      if (t.image) {
        body = '<div class="pv-wrap"><img class="pv-img" src="' + url + '" alt="' + esc(title) + '"></div>' + meta;
      } else if (t.ext === 'pdf') {
        body = '<iframe class="pv-frame" src="' + url + '" title="' + esc(title) + '"></iframe>' + meta;
      } else if (/^(txt|csv|json)$/.test(t.ext)) {
        var txt = '';
        try { txt = utf8Decode(buf).slice(0, 20000); } catch (e) { txt = '文本解码失败'; }
        body = '<pre class="pv-pre">' + esc(txt) + '</pre>' + meta;
      } else {
        body = '<div class="pv-ph">该文件为 ' + esc(t.ext.toUpperCase()) +
          ' 格式，浏览器不提供内嵌预览，请下载后用对应软件打开。</div>' + meta;
      }
      $('modalTitle').textContent = title;
      $('modalBody').innerHTML = body;
      $('modalFoot').innerHTML = '<button class="btn ghost sm" data-act="modalClose">关闭</button>' +
        '<button class="btn primary sm" data-act="downloadOrig" data-k="' + esc(k) + '" data-i="' + i + '">下载原文件</button>';
      $('modal').classList.add('wide');
      openModal();
    }).catch(function (e) { toast('读取材料失败：' + (e && e.message ? e.message : '未知错误')); });
  }
  function downloadOrig(k, i) {
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r) { toast('请先打开一条单据'); return; }
    var f = ((r.materials && r.materials[k]) || [])[i];
    if (!f) return;
    fileBuffer(f).then(function (buf) {
      if (!buf) { toast('该材料暂无文件本体'); return; }
      var t = fileType(f, buf);
      var nm = sanitize((MATNAME[k] || k) + '-' + (f.name || '材料')) + '.' + t.ext;
      download(buf, nm, t.mime);
    }).catch(function (e) { toast('下载失败：' + (e && e.message ? e.message : '未知错误')); });
  }
  function closeDrawer() {
    $('mask').hidden = true; $('drawer').hidden = true;
    clearThumbs(); currentId = null;
  }

  /* ---------- 弹窗 ---------- */
  function openModal() { $('modalMask').hidden = false; $('modal').hidden = false; }
  function closeModal() {
    $('modalMask').hidden = true; $('modal').hidden = true;
    $('modal').classList.remove('wide'); _modalYes = null;
  }
  function confirmDialog(title, text, onYes) {
    _modalYes = onYes;
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = '<p class="hint">' + esc(text) + '</p>';
    $('modalFoot').innerHTML = '<button class="btn ghost" data-act="modalClose">取消</button>' +
      '<button class="btn danger" data-act="modalOk">确认</button>';
    openModal();
  }
  function openLogin() {
    var u = state.user || { username: '', academy: '', dept: '' };
    $('modalTitle').textContent = '身份登记';
    $('modalBody').innerHTML =
      '<p class="hint">用户名、书院、部门均为<b>手动填写</b>，网页版不获取任何微信资料；在线共享模式下，您提交的单据与材料会在本站服务端同步。</p>' +
      '<div class="frow"><label class="req">用户名</label><input class="fin" id="lgName" maxlength="40" value="' + esc(u.username) + '" placeholder="请输入姓名"></div>' +
      '<div class="frow"><label>书院</label><input class="fin" id="lgAcademy" maxlength="40" value="' + esc(u.academy) + '" placeholder="如：宸阳书院"></div>' +
      '<div class="frow"><label>部门</label><input class="fin" id="lgDept" maxlength="40" value="' + esc(u.dept) + '" placeholder="如：学生会"></div>' +
      '<label class="chk" style="margin-top:12px"><input type="checkbox" id="lgAgree"> 我已阅读并同意 <a href="#" data-act="privacyLink">《隐私协议》</a>（需主动勾选）</label>';
    $('modalFoot').innerHTML = '<button class="btn ghost" data-act="logout">退出登录</button>' +
      '<button class="btn primary" data-act="loginSubmit">进入系统</button>';
    openModal();
  }
  function openPrivacy() {
    var storeNote = online.enabled
      ? '2. 当前为<b>在线共享模式</b>：您填写的单据（含提交人姓名、部门等）、公告，以及您添加的<b>材料原始文件（含图片）</b>会保存在本站服务端，并在打开同一分享链接的设备间自动同步，以便各设备直接预览与一键导出；<b>身份登记、审核密钥与未读状态仍只留在本机浏览器</b>，不会上传。'
      : '2. 当前为<b>纯本地模式</b>：所有数据仅保存在当前浏览器的 localStorage 与 IndexedDB 中，不会自动上传服务器；仅在您主动配置「云同步」并点击上传时才会发送到您填写的网关地址。';
    $('modalTitle').textContent = '隐私协议（网页版）';
    $('modalBody').innerHTML = '<p class="hint">1. 本网页版仅采集您<b>手动填写</b>的用户名、书院、部门，以及您主动上传的报销材料；不获取微信昵称、头像、openid 等任何微信资料。<br>' +
      storeNote + '<br>' +
      '3. 您可通过「数据管理」导出备份、清理或清空全部数据。<br>' +
      '4. 未勾选同意前，不会写入任何身份信息。</p>';
    $('modalFoot').innerHTML = '<button class="btn primary" data-act="loginOpen">返回登记</button>';
    openModal();
  }
  function loginSubmit() {
    var name = ($('lgName').value || '').trim();
    if (!name) { toast('请填写用户名'); return; }
    if (!$('lgAgree').checked) { toast('请先阅读并勾选同意《隐私协议》'); return; }
    state.user = { username: name, academy: ($('lgAcademy').value || '').trim(), dept: ($('lgDept').value || '').trim() };
    saveState(); closeModal(); renderAll(); toast('已登记身份：' + name);
  }
  function logout() { state.user = null; saveState(); closeModal(); renderAll(); toast('已退出登录'); }

  /* ---------- 角色解锁（仅比对摘要，密钥明文不在网页中出现） ---------- */
  function unlock(target) {
    var input = $(target === 'history' ? 'histKey' : 'audKey');
    var role = keyRole((input && input.value) || '');
    if (!role) { toast('密钥错误，请重新输入'); return; }
    if (target === 'history' && role !== 'admin') { toast('全部历史需最高管理密钥'); return; }
    if (input) input.value = '';
    state.role = role; saveState(); renderAll(); toast('已解锁：' + roleLabel(role));
  }
  function roleLogout() { state.role = null; saveState(); renderAll(); toast('已退出审核角色'); }

  /* ---------- 提交端 ---------- */
  function initFormSelects() {
    $('fType').innerHTML = TYPES.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('');
    $('fPay').innerHTML = PAY_METHODS.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
    $('wStage').innerHTML = '<option value="">全部阶段</option>' + STAGES.map(function (s) {
      return '<option value="' + s.k + '">' + esc(s.name) + '</option>';
    }).join('');
    $('wType').innerHTML = '<option value="">全部类型</option>' + TYPES.map(function (t) {
      return '<option value="' + t + '">' + t + '</option>';
    }).join('');
  }
  function activeMats() { return getMaterials($('fType').value || '活动', $('fClothing').checked); }
  function totalFormFiles() {
    var n = 0; Object.keys(formFiles).forEach(function (k) { n += (formFiles[k] || []).length; });
    return n;
  }
  function renderFormMats() {
    $('fMats').innerHTML = activeMats().map(function (m) {
      var list = formFiles[m.key] || [];
      return '<div class="mat-block"><div class="mat-hd">' +
        '<div class="n">' + esc(MATNAME[m.key] || m.key) +
        (m.required ? '<span class="must">必交</span>' : '<span class="opt">选交</span>') +
        (m.multiple ? '<span class="opt">可多份</span>' : '<span class="opt">仅单份</span>') + '</div>' +
        '<label class="btn ghost sm file-btn">选择文件<input type="file" data-mat="' + esc(m.key) + '" ' +
        (m.multiple ? 'multiple' : '') + ' hidden accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"></label></div>' +
        '<div class="chips">' + (list.length ? list.map(function (f, i) {
          return '<span class="chip"><span>' + esc(f.name) + '</span><b data-act="delMat" data-key="' + esc(m.key) + '" data-i="' + i + '">×</b></span>';
        }).join('') : '<span class="t-sub">未选择</span>') + '</div></div>';
    }).join('');
    $('fCount').textContent = '已选 ' + totalFormFiles() + ' / ' + MAX_FILES + ' 份';
  }
  function resetForm() {
    formFiles = {};
    $('fReason').value = ''; $('fTotal').value = ''; $('fTotalFmt').textContent = '¥0.00';
    $('fNote').value = ''; $('fClothing').checked = false;
    $('fType').selectedIndex = 0; $('fPay').selectedIndex = 0;
    renderFormMats();
  }
  function onMatFiles(input) {
    var key = input.dataset.mat;
    var files = Array.from(input.files || []);
    if (!files.length) return;
    var mat = activeMats().find(function (m) { return m.key === key; });
    var cur = formFiles[key] || (formFiles[key] = []);
    if (mat && !mat.multiple && cur.length > 0) { toast('该项仅支持单份'); input.value = ''; return; }
    var free = MAX_FILES - totalFormFiles();
    if (free <= 0) { toast('已达 ' + MAX_FILES + ' 份上限'); input.value = ''; return; }
    var use = files.slice(0, mat && !mat.multiple ? 1 : free);
    (async function () {
      for (var i = 0; i < use.length; i++) {
        var file = use[i];
        var buf = await file.arrayBuffer();
        var fkey = uid();
        await putFile(fkey, new Uint8Array(buf));
        var ext = guessExt(file.name) || 'bin';
        cur.push({
          name: file.name, ext: ext, size: buf.byteLength,
          type: /^(png|jpg|jpeg|gif|webp|bmp)$/i.test(ext) ? 'image' : 'file',
          key: fkey, path: '', fileID: '', _buf: new Uint8Array(buf)
        });
      }
      input.value = '';
      renderFormMats();
      toast('已添加 ' + use.length + ' 份材料' + (files.length > use.length ? '（超出上限部分已忽略）' : ''));
    })().catch(function (e) { toast('读取文件失败：' + e.message); });
  }
  function delMat(key, i) {
    var arr = formFiles[key] || [];
    var f = arr[i]; if (!f) return;
    if (f.key) delFile(f.key);
    arr.splice(i, 1); renderFormMats();
  }
  function submitForm() {
    if (!state.user) { toast('请先完成身份登记'); openLogin(); return; }
    var reason = ($('fReason').value || '').trim();
    var total = parseFloat($('fTotal').value) || 0;
    if (!reason) { toast('请填写报销事由'); return; }
    if (total <= 0) { toast('请填写报销总额'); return; }
    var mats = activeMats();
    for (var i = 0; i < mats.length; i++) {
      if (mats[i].required && !(formFiles[mats[i].key] || []).length) {
        toast('请上传【' + (MATNAME[mats[i].key] || mats[i].key) + '】'); return;
      }
    }
    var materialObj = {};
    Object.keys(formFiles).forEach(function (k) {
      if ((formFiles[k] || []).length) {
        materialObj[k] = formFiles[k].map(function (f) {
          return { name: f.name, ext: f.ext, size: f.size, type: f.type, key: f.key, path: '', fileID: '' };
        });
      }
    });
    var now = Date.now();
    var rec = {
      id: genId('R'), userId: state.user.username, name: state.user.username, sid: '',
      academy: state.user.academy || '', dept: state.user.dept || '', phone: '',
      reason: reason, type: $('fType').value, payMethod: $('fPay').value,
      clothing: $('fClothing').checked, total: total, note: ($('fNote').value || '').trim(),
      materials: materialObj, stage: 0, rejected: false, rejectReason: '', rejectAt: 0,
      rejectBy: '', rejectLog: [], stageLog: { 0: now }, createdAt: now, updatedAt: now
    };
    state.records.unshift(rec);
    saveState(); resetForm(); renderAll();
    toast('提交成功：' + rec.id);
  }

  /* ---------- 审核流转（对齐 store.js toggleStage / rejectRecord） ---------- */
  function clearRejectActive(rec) {
    rec.rejected = false; rec.rejectReason = ''; rec.rejectAt = 0; rec.rejectBy = '';
  }
  function toggleStage(k) {
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r || !isAuditor()) return;
    var v = Number(k);
    r.stageLog = r.stageLog || {};
    if (r.rejected && v <= r.stage) clearRejectActive(r);
    else if (v > r.stage) { r.stage = v; r.stageLog[v] = Date.now(); clearRejectActive(r); }
    else { r.stage = v; clearRejectActive(r); }
    r.updatedAt = Date.now();
    saveState(); renderAll(); openDrawer(r.id, 'audit');
    toast('流程已更新为「' + STAGES[v].name + '」');
  }
  function rejectOpen() {
    $('modalTitle').textContent = '退回申请（必填原因）';
    $('modalBody').innerHTML = '<p class="hint">退回后单据回到「已提交」阶段，原因将展示给提交人。</p>' +
      '<textarea class="fin" id="rejText" maxlength="200" placeholder="请输入退回原因（必填）"></textarea>';
    $('modalFoot').innerHTML = '<button class="btn ghost" data-act="modalClose">取消</button>' +
      '<button class="btn danger" data-act="rejectConfirm">确认退回</button>';
    openModal();
  }
  function rejectConfirm() {
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r) { closeModal(); return; }
    var txt = ($('rejText').value || '').trim();
    if (!txt) { toast('请填写退回原因'); return; }
    r.rejected = true; r.stage = 0;
    r.rejectReason = txt; r.rejectAt = Date.now(); r.rejectBy = roleLabel(state.role);
    r.rejectLog = r.rejectLog || [];
    r.rejectLog.push({ reason: txt, by: r.rejectBy, at: r.rejectAt });
    r.updatedAt = Date.now();
    saveState(); closeModal(); renderAll(); openDrawer(r.id, 'audit');
    toast('已退回该申请');
  }
  function deleteRec() {
    if (!isAdmin()) { toast('仅最高管理可删除项目'); return; }
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r) return;
    confirmDialog('删除单据', '确认删除《' + r.reason + '》及其全部材料？此操作不可恢复。', function () {
      releaseRecordFiles(r).then(function () {
        state.records = state.records.filter(function (x) { return x.id !== r.id; });
        selected.delete(r.id);
        saveState(); closeDrawer(); renderAll(); toast('已删除单据');
      });
    });
  }
  function onDrawerFiles(input) {
    var r = state.records.find(function (x) { return x.id === currentId; });
    if (!r) return;
    var files = Array.from(input.files || []); if (!files.length) return;
    var free = MAX_FILES - countMats(r);
    if (free <= 0) { toast('已达 ' + MAX_FILES + ' 份上限'); input.value = ''; return; }
    var use = files.slice(0, free);
    (async function () {
      if (!r.materials.other) r.materials.other = [];
      for (var i = 0; i < use.length; i++) {
        var file = use[i], buf = await file.arrayBuffer(), key = uid();
        await putFile(key, new Uint8Array(buf));
        var ext = guessExt(file.name) || 'bin';
        r.materials.other.push({
          name: file.name, ext: ext, size: buf.byteLength,
          type: /^(png|jpg|jpeg|gif|webp|bmp)$/i.test(ext) ? 'image' : 'file',
          key: key, path: '', fileID: ''
        });
      }
      input.value = ''; saveState(); renderAll();
      openDrawer(r.id, currentTab === 'audit' ? 'audit' : 'track');
      toast('已添加 ' + use.length + ' 个本地文件');
    })().catch(function (e) { toast('读取文件失败：' + e.message); });
  }

  /* ---------- 公告 ---------- */
  function annEditor(id) {
    if (!isAdmin()) { toast('仅最高管理可发布 / 修改公告'); return; }
    var a = id ? state.announcements.find(function (x) { return x._id === id; }) : null;
    $('modalTitle').textContent = a ? '编辑公告' : '发布公告';
    $('modalBody').innerHTML =
      '<div class="frow"><label class="req">标题</label><input class="fin" id="anTitle" maxlength="60" value="' + esc(a ? a.title : '') + '" placeholder="请输入公告标题"></div>' +
      '<div class="frow"><label>内容</label><textarea class="fin" id="anContent" maxlength="1000" placeholder="请输入公告内容（选填）">' + esc(a ? a.content : '') + '</textarea></div>' +
      '<label class="chk" style="margin-top:10px"><input type="checkbox" id="anPinned" ' + (a && a.pinned ? 'checked' : '') + '> 置顶显示</label>';
    $('modalFoot').innerHTML = '<button class="btn ghost" data-act="modalClose">取消</button>' +
      '<button class="btn primary" data-act="annSave" data-id="' + esc(id || '') + '">' + (a ? '保存' : '发布') + '</button>';
    openModal();
  }
  function annSave(id) {
    var title = ($('anTitle').value || '').trim();
    if (!title) { toast('请填写标题'); return; }
    var content = $('anContent').value || '', pinned = $('anPinned').checked, now = Date.now();
    if (id) {
      var a = state.announcements.find(function (x) { return x._id === id; });
      if (!a) { closeModal(); return; }
      a.title = title; a.content = content; a.pinned = pinned; a.updatedAt = now;
    } else {
      state.announcements.push({ _id: genId('A'), title: title, content: content, pinned: pinned, createdAt: now, updatedAt: now });
    }
    saveState(); closeModal(); renderAll(); toast(id ? '公告已保存' : '公告已发布');
  }
  function annDel(id) {
    if (!isAdmin()) { toast('仅最高管理可删除公告'); return; }
    var a = state.announcements.find(function (x) { return x._id === id; });
    confirmDialog('删除公告', '确认删除《' + (a ? a.title : '') + '》？此操作不可恢复。', function () {
      state.announcements = state.announcements.filter(function (x) { return x._id !== id; });
      saveState(); renderAll(); toast('已删除公告');
    });
  }
  function annReadAll() { state.lastRead = Date.now(); saveState(); renderAll(); toast('已全部标为已读'); }

  /* ---------- 一键导出 ZIP ---------- */
  function setProgress(p, text) { $('pgFill').style.width = p + '%'; $('pgText').textContent = text; }
  function showProgress(title) { $('pgTitle').textContent = title; setProgress(0, '准备中'); $('progress').hidden = false; }
  function hideProgress() { $('progress').hidden = true; }
  function bump() { pgDone++; setProgress(Math.min(96, Math.round(pgDone / pgTotal * 96)), '已处理 ' + pgDone + ' / ' + pgTotal + ' 个文件'); }
  function recordInfo(r) {
    var L = [];
    L.push('宸阳书院报销系统 · 单据信息');
    L.push('========================================');
    L.push('单据编号：' + r.id);
    L.push('报销事由：' + r.reason);
    L.push('报销类型：' + r.type);
    L.push('报销金额：' + fmtMoney(r.total));
    L.push('付款方式：' + (r.payMethod || '—'));
    L.push('提交人：' + (r.name || '—') + '  书院：' + (r.academy || '—') + '  部门：' + (r.dept || '—'));
    L.push('当前阶段：' + stageLabel(r));
    L.push('提交时间：' + fmtDate(r.createdAt));
    L.push('备注：' + (r.note || '—'));
    if (r.rejected) L.push('退回原因：' + (r.rejectReason || '未填写'));
    L.push('');
    L.push('流程时间线：');
    STAGES.forEach(function (s) {
      var t = (r.stageLog && r.stageLog[s.k]) ? fmtTime(r.stageLog[s.k]) : '—';
      L.push('  [' + ((!r.rejected && Number(r.stage) >= s.k) ? 'x' : ' ') + '] ' + s.name + '   ' + t);
    });
    L.push('');
    L.push('材料清单（共 ' + countMats(r) + ' 份）：');
    Object.keys(r.materials || {}).forEach(function (k) {
      (r.materials[k] || []).forEach(function (f, i) {
        L.push('  ' + (MATNAME[k] || k) + ' ' + (i + 1) + '：' + (f.name || '—') + '  [' + (f.ext || 'bin') + ']');
      });
    });
    L.push('');
    L.push('说明：本文件由网页版工作台生成。');
    return L.join('\n');
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildCsv(list) {
    var head = ['单据编号', '报销事由', '类型', '提交人', '书院', '部门', '金额(元)', '付款方式', '当前阶段', '是否退回', '退回原因', '材料数', '提交时间'];
    var rows = list.map(function (r) {
      return [r.id, r.reason, r.type, r.name, r.academy, r.dept, (Number(r.total) || 0).toFixed(2),
        r.payMethod, stageLabel(r), r.rejected ? '是' : '否', r.rejectReason || '', countMats(r), fmtDate(r.createdAt)];
    });
    return '\uFEFF' + [head].concat(rows).map(function (x) { return x.map(csvCell).join(','); }).join('\r\n');
  }
  function buildReadme(list, mode, failures, fileCount) {
    var L = [];
    L.push('宸阳书院报销系统 · 网页版一键导出说明');
    L.push('========================================');
    L.push('导出时间：' + new Date().toLocaleString('zh-CN'));
    L.push('导出模式：' + mode);
    L.push('单据数量：' + list.length + ' 条');
    L.push('文件数量：' + fileCount + ' 个');
    L.push('数据来源：本地文件仓库 + 共享服务材料本体（多端共享已启用时）');
    L.push('');
    L.push('目录与命名规则');
    L.push('  按材料板块分文件夹：发票/、策划案（附预算表）/、支付截图/ 等');
    L.push('  板块文件夹内为 序号-原文件名.扩展名，例如 01-发票 1.png');
    L.push('  单条导出：00-单据信息.txt + 各板块文件夹');
    L.push('  批量导出：每条单据一个子目录，子目录内再按板块分文件夹；根目录附 汇总.csv 与本说明');
    L.push('  扩展名按文件头自动校正，图片与 PDF 均为原始二进制，可直接打开，未做文本转码');
    L.push('  中文文件名使用 UTF-8 标志位，Windows / macOS 均可正常解压');
    L.push('');
    if (failures.length) {
      L.push('未能包含的文件（' + failures.length + ' 项）');
      failures.forEach(function (f) { L.push('  - ' + f); });
      L.push('  原因：该材料仅含云端 fileID 或外部路径，本机与共享服务均无文件本体。');
      L.push('  处理：在网页版详情页「添加本地材料」，或导入完整快照后再导出。');
    } else L.push('全部材料均已包含，无跳过项。');
    L.push('');
    L.push('注：ZIP 采用 STORE 方式（不压缩），以保证中文名兼容与打包速度。');
    return L.join('\n');
  }
  function collectEntries(rec, prefix, failures) {
    var base = prefix ? prefix + '/' : '';
    var out = [{ name: base + '00-单据信息.txt', buffer: textBuffer(recordInfo(rec)) }];
    var keys = Object.keys(rec.materials || {});
    return keys.reduce(function (chain, k) {
      return chain.then(function () {
        // 每个材料板块一个子文件夹，文件夹名即板块中文名
        var folder = sanitize(MATNAME[k] || k) || '材料';
        var list = rec.materials[k] || [];
        if (!list.length) return;
        // 显式目录条目：保证各解压工具都能正确显示中文文件夹名
        out.push({ name: base + folder + '/', buffer: new Uint8Array(0) });
        var idx = 0;
        return list.reduce(function (ch, f) {
          return ch.then(function () {
            idx++;
            return fileBuffer(f).then(function (buf) {
              if (!buf || (buf.byteLength || buf.length || 0) === 0) {
                failures.push(rec.id + ' / ' + (MATNAME[k] || k) + ' / ' + (f.name || '文件') + '（未找到文件本体）');
                bump(); return;
              }
              // 扩展名以文件头为准：PNG 就写 .png，PDF 就写 .pdf，避免被误标成文本
              var t = fileType(f, buf);
              var raw = sanitize(f.name || MATNAME[k] || '材料');
              raw = raw.replace(/\.(png|jpe?g|gif|webp|bmp|pdf|txt|csv|docx?|xlsx?|zip|bin)$/i, '') || '材料';
              var nm = folder + '/' + pad(idx) + '-' + raw + '.' + t.ext;
              out.push({ name: base + nm, buffer: buf });
              bump();
              if (pgDone % 2 === 0) return sleep0();
            });
          });
        }, Promise.resolve());
      });
    }, Promise.resolve()).then(function () { return out; });
  }
  function exportRecords(list) {
    if (!list.length) { toast('请先选择要导出的单据'); return; }
    var batch = list.length > 1;
    showProgress(batch ? '正在批量打包…' : '正在打包单据…');
    pgDone = 0;
    pgTotal = Math.max(1, list.reduce(function (n, r) { return n + countMats(r) + 1; }, 0));
    var failures = [], entries = [];
    (async function () {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var prefix = batch ? (pad(i + 1) + '-' + sanitize(r.reason || '单据') + '-' + sanitize(r.id)) : '';
        setProgress(Math.min(96, Math.round(pgDone / pgTotal * 96)), '正在处理第 ' + (i + 1) + ' / ' + list.length + ' 条单据');
        entries = entries.concat(await collectEntries(r, prefix, failures));
      }
      if (batch) entries.push({ name: '汇总.csv', buffer: textBuffer(buildCsv(list)) });
      setProgress(98, '正在生成 ZIP…');
      await sleep0();
      var realCount = function () {
        return entries.filter(function (e) { return !/\/$/.test(e.name); }).length;
      };
      entries.push({ name: '导出说明.txt', buffer: textBuffer(buildReadme(list, batch ? '批量导出' : '单条导出', failures, realCount() + 1)) });
      var bytes = buildZip(entries);
      var fn = batch ? ('报销材料-批量-' + dateStr() + '.zip')
        : ('报销材料-' + sanitize(list[0].reason || '单据') + '-' + sanitize(list[0].id) + '.zip');
      setProgress(100, '打包完成，正在下载');
      download(bytes, fn);
      toast('已导出 ' + list.length + ' 条单据 / ' + realCount() + ' 个文件' +
        (failures.length ? ('，' + failures.length + ' 项跳过（见导出说明）') : ''));
    })().catch(function (e) {
      toast('导出失败：' + (e && e.message ? e.message : '未知错误'));
    }).then(function () { setTimeout(hideProgress, 450); });
  }

  /* ---------- 数据管理：JSON / 完整快照 ---------- */
  function normalizeRecord(x) {
    if (!x || typeof x !== 'object') return null;
    var mats = {};
    Object.keys(x.materials || {}).forEach(function (k) {
      mats[k] = (Array.isArray(x.materials[k]) ? x.materials[k] : []).map(function (f) {
        return {
          type: (f && f.type) || 'file',
          name: (f && f.name) || MATNAME[k] || k,
          ext: (f && f.ext && f.ext !== 'IMG') ? String(f.ext).toLowerCase() : guessExt((f && (f.path || f.name)) || ''),
          size: (f && Number(f.size)) || 0,
          key: (f && f.key) || '', path: (f && f.path) || '', fileID: (f && f.fileID) || ''
        };
      });
    });
    return {
      id: String(x.id || genId('R')), userId: x.userId || '', name: x.name || x.userId || '—', sid: x.sid || '',
      academy: x.academy || '', dept: x.dept || '', phone: x.phone || '',
      reason: x.reason || '（未填写事由）', type: x.type || '其他', payMethod: x.payMethod || '',
      clothing: !!x.clothing, total: Number(x.total) || 0, note: x.note || '',
      materials: mats, stage: Math.min(4, Math.max(0, Number(x.stage) || 0)),
      rejected: !!x.rejected, rejectReason: x.rejectReason || '', rejectAt: Number(x.rejectAt) || 0,
      rejectBy: x.rejectBy || '', rejectLog: Array.isArray(x.rejectLog) ? x.rejectLog : [],
      stageLog: x.stageLog || { 0: x.createdAt || Date.now() },
      createdAt: Number(x.createdAt) || Date.now(), updatedAt: Number(x.updatedAt) || Date.now()
    };
  }
  function exportJSON() {
    var data = {
      version: 2, app: '宸阳书院报销系统-网页版', exportedAt: Date.now(),
      records: state.records.map(cleanRec), announcements: state.announcements
    };
    download(textBuffer(JSON.stringify(data, null, 2)), '报销数据-' + dateStr() + '.json', 'application/json');
    toast('已导出 JSON 备份（元数据，不含文件本体）');
  }
  function importJSON(file) {
    file.text().then(function (txt) {
      var data = JSON.parse(txt);
      var arr = Array.isArray(data) ? data : (data.records || []);
      if (!Array.isArray(arr)) throw new Error('JSON 顶层应为数组或含 records 字段的对象');
      var next = arr.map(normalizeRecord).filter(Boolean);
      if (!next.length) throw new Error('未解析到有效记录');
      confirmDialog('导入 JSON', '将用 ' + next.length + ' 条记录覆盖当前数据（不含文件本体，材料需另行添加）。', function () {
        state.records = next;
        if (Array.isArray(data.announcements)) state.announcements = data.announcements;
        selected.clear(); saveState(); renderAll();
        toast('已导入 ' + next.length + ' 条记录');
      });
    }).catch(function (e) { toast('导入失败：' + (e && e.message ? e.message : '格式错误')); });
  }
  function exportSnapshot() {
    showProgress('正在生成完整快照…');
    var entries = [], snapRecords = [], seq = 0;
    (async function () {
      for (var i = 0; i < state.records.length; i++) {
        var r = state.records[i], m = {};
        setProgress(Math.round(i / Math.max(1, state.records.length) * 90), '正在收集第 ' + (i + 1) + ' / ' + state.records.length + ' 条单据的材料');
        var keys = Object.keys(r.materials || {});
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j]; m[k] = [];
          for (var n = 0; n < (r.materials[k] || []).length; n++) {
            var f = r.materials[k][n];
            var meta = { name: f.name, ext: f.ext, size: f.size, type: f.type, path: f.path || '', fileID: f.fileID || '', file: '' };
            var buf = await fileBuffer(f);
            if (buf) {
              var ext = (f.ext && f.ext !== 'IMG') ? String(f.ext).toLowerCase() : guessExt(f.path || f.name || '');
              var p = '材料/' + sanitize(r.id) + '/' + sanitize(k) + '/' + pad(++seq) + '.' + ext;
              entries.push({ name: p, buffer: buf });
              meta.file = p;
            }
            m[k].push(meta);
          }
        }
        snapRecords.push(Object.assign({}, cleanRec(r), { materials: m }));
      }
      var payload = {
        version: 2, app: '宸阳书院报销系统-网页版', exportedAt: Date.now(),
        records: snapRecords, announcements: state.announcements, lastRead: state.lastRead
      };
      entries.unshift({ name: 'records.json', buffer: textBuffer(JSON.stringify(payload, null, 2)) });
      entries.push({
        name: '说明.txt', buffer: textBuffer(
          '宸阳书院报销系统 · 完整数据快照\n' +
          '========================================\n' +
          '导出时间：' + new Date().toLocaleString('zh-CN') + '\n' +
          '单据：' + state.records.length + ' 条 / 公告：' + state.announcements.length + ' 条 / 材料：' + seq + ' 份\n\n' +
          'records.json 为记录与公告元数据；材料/ 目录存放全部文件本体。\n' +
          '在另一台设备打开网页版，进入「数据管理 → 导入完整快照」选择本 ZIP 即可完整恢复。\n' +
          'ZIP 采用 STORE 方式，中文文件名使用 UTF-8 标志位。\n'
        )
      });
      setProgress(96, '正在生成 ZIP…');
      await sleep0();
      var bytes = buildZip(entries);
      setProgress(100, '快照生成完成，正在下载');
      download(bytes, '报销数据快照-' + dateStr() + '.zip');
      toast('已导出完整快照：' + state.records.length + ' 条单据 / ' + seq + ' 份材料');
    })().catch(function (e) {
      toast('快照导出失败：' + (e && e.message ? e.message : '未知错误'));
    }).then(function () { setTimeout(hideProgress, 450); });
  }
  function importSnapshot(file) {
    file.arrayBuffer().then(function (ab) {
      var entries = unzipStore(new Uint8Array(ab));
      var rf = entries.find(function (e) { return e.name === 'records.json'; });
      if (!rf) throw new Error('快照缺少 records.json');
      var data = JSON.parse(utf8Decode(rf.data));
      var arr = Array.isArray(data.records) ? data.records : [];
      var byName = {};
      entries.forEach(function (e) { byName[e.name] = e.data; });
      confirmDialog('导入完整快照', '将用快照中的 ' + arr.length + ' 条单据、' +
        ((data.announcements || []).length) + ' 条公告及全部材料覆盖当前数据。', function () {
        (async function () {
          showProgress('正在恢复材料…');
          var next = [];
          for (var i = 0; i < arr.length; i++) {
            var rec = normalizeRecord(arr[i]);
            if (!rec) continue;
            var keys = Object.keys(rec.materials || {});
            for (var j = 0; j < keys.length; j++) {
              var k = keys[j], src = (arr[i].materials && arr[i].materials[k]) || [];
              for (var n = 0; n < rec.materials[k].length; n++) {
                var f = rec.materials[k][n], p = src[n] && src[n].file;
                if (p && byName[p]) {
                  var key = uid();
                  await putFile(key, byName[p]);
                  f.key = key; f.size = byName[p].length;
                }
              }
            }
            next.push(rec);
            setProgress(Math.round((i + 1) / Math.max(1, arr.length) * 96), '已恢复 ' + (i + 1) + ' / ' + arr.length + ' 条');
          }
          state.records = next;
          state.announcements = Array.isArray(data.announcements) ? data.announcements : [];
          state.lastRead = Number(data.lastRead) || 0;
          selected.clear(); currentId = null;
          saveState(); renderAll(); hideProgress();
          toast('已恢复 ' + next.length + ' 条单据及其材料');
        })().catch(function (e) { hideProgress(); toast('导入失败：' + e.message); });
      });
    }).catch(function (e) { toast('导入失败：' + (e && e.message ? e.message : '文件无法解析')); });
  }
  function cleanupExpired() {
    var expired = state.records.filter(function (r) { return r.stage >= 4 && (r.updatedAt || 0) < Date.now() - EXPIRE_MS; });
    if (!expired.length) { toast('无过期记录（已完成且 30 天未变动）'); return; }
    confirmDialog('清理过期记录', '将删除 ' + expired.length + ' 条已完成且超过 30 天未变动的记录及其材料。', function () {
      Promise.all(expired.map(releaseRecordFiles)).then(function () {
        var ids = {}; expired.forEach(function (r) { ids[r.id] = 1; });
        state.records = state.records.filter(function (r) { return !ids[r.id]; });
        expired.forEach(function (r) { selected.delete(r.id); });
        saveState(); renderAll(); toast('已清理 ' + expired.length + ' 条过期记录');
      });
    });
  }
  function clearAll() {
    confirmDialog('清空全部', '将删除所有单据、公告与材料，不可恢复！', function () {
      Promise.all(state.records.map(releaseRecordFiles)).then(function () {
        state.records = []; state.announcements = []; selected.clear(); currentId = null;
        saveState(); renderAll(); toast('已清空全部数据');
      });
    });
  }

  /* ---------- 在线共享（本站 /api/state，自动多端同步） ----------
   * 探测到后端才启用；file:// 或纯静态托管自动降级为纯本地，原功能不受影响。
   * 服务端为唯一数据源：写操作后防抖推送，6 秒轮询 rev；服务端按 id + updatedAt
   * 做记录级合并并返回全量，客户端以返回值覆盖本机，保证各端最终一致。 */
  var online = {
    enabled: false, applying: false, pushing: false,
    pushTimer: null, pollTimer: null, rev: 0, lastOk: 0
  };

  function apiFetch(p, opt) {
    return fetch(p, Object.assign({ cache: 'no-store' }, opt || {})).then(function (res) {
      return res.text().then(function (txt) {
        var j = {};
        try { j = JSON.parse(txt || '{}'); } catch (e) { j = {}; }
        if (!res.ok) throw new Error((j && j.msg) || ('HTTP ' + res.status));
        if (j && j.ok === false) throw new Error(j.msg || '服务端拒绝请求');
        return j;
      });
    });
  }
  function apiPost(body) {
    return apiFetch('./api/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  function setOnlineStatus(t) {
    try { if ($('syncStatus')) $('syncStatus').textContent = t; } catch (e) { }
  }
  function userBusy() {
    var el = document.activeElement;
    return !!composing || !!(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  /* 远端记录带回的 key 在原设备生成；优先还原本机已有的 key，避免重复下载。
   * 本机没有该 key 时，getFile 会按 key 向 /api/file 取回其它设备上传的原始文件。 */
  function preserveLocalKeys(remote) {
    var map = {};
    state.records.forEach(function (r) {
      if (!r || !r.id) return;
      var m = {};
      Object.keys(r.materials || {}).forEach(function (k) {
        (r.materials[k] || []).forEach(function (f, i) { m[k + ':' + i + ':' + ((f && f.name) || '')] = (f && f.key) || ''; });
      });
      map[r.id] = m;
    });
    remote.forEach(function (r) {
      var m = map[r.id] || {};
      Object.keys(r.materials || {}).forEach(function (k) {
        (r.materials[k] || []).forEach(function (f, i) {
          var key = m[k + ':' + i + ':' + (f.name || '')];
          if (key) f.key = key;
        });
      });
    });
  }
  function applyRemote(j) {
    if (!j || j.ok === false) return;
    online.applying = true;
    try {
      online.rev = Number(j.rev) || 0;
      var next = (Array.isArray(j.records) ? j.records : []).map(normalizeRecord)
        .filter(function (r) { return r && !isDemoRec(r); });
      preserveLocalKeys(next);
      state.records = next;
      if (Array.isArray(j.announcements)) {
        state.announcements = j.announcements.filter(function (a) { return !isDemoAnn(a); });
      }
      if (j.tombs && typeof j.tombs === 'object') state.tombs = j.tombs;
      selected.clear();
      saveState();
      renderAll();
    } finally { online.applying = false; }
  }
  function scheduleOnlinePush() {
    if (!online.enabled || online.applying) return;
    clearTimeout(online.pushTimer);
    online.pushTimer = setTimeout(onlinePush, 900);
  }
  function onlinePush() {
    if (!online.enabled || online.applying) return;
    if (online.pushing) { scheduleOnlinePush(); return; }
    online.pushing = true;
    return apiPost({
      baseRev: online.rev,
      records: state.records.map(cleanRec),
      announcements: state.announcements,
      tombs: state.tombs || {}
    }).then(function (j) {
      online.pushing = false;
      online.lastOk = Date.now();
      applyRemote(j);
      setOnlineStatus('在线共享 ✓ 已同步（' + new Date().toLocaleTimeString('zh-CN') + '）· 所有打开此链接的设备共用同一份数据');
    }).catch(function (e) {
      online.pushing = false;
      setOnlineStatus('同步失败：' + e.message + '（数据已存本机，稍后自动重试）');
    });
  }
  function onlinePoll() {
    if (!online.enabled || online.applying || online.pushing || userBusy()) return;
    apiFetch('./api/state').then(function (j) {
      if (j && Number(j.rev) !== online.rev) applyRemote(j);
      online.lastOk = Date.now();
    }).catch(function () { setOnlineStatus('连接中断，正在重试；本地功能不受影响'); });
  }
  function initOnlineShare() {
    if (!/^https?:$/.test(location.protocol)) return;   // 本地双击打开 → 保持纯本地
    apiFetch('./api/ping').then(function (j) {
      if (!j || j.ok !== true || j.mode !== 'shared') return;
      online.enabled = true;
      setOnlineStatus('在线共享：正在连接…');
      // 无论云端是否为空，首次都走一次「合并式上传」：服务端按 id + updatedAt 逐条合并，
      // 既不会让各设备各自的演示数据重复叠加，也不会抹掉本机独有的历史数据。
      return onlinePush().then(function () {
        setOnlineStatus('在线共享 ✓ 多端数据已互通（' + new Date().toLocaleTimeString('zh-CN') + '）');
        shareExistingFiles();   // 非阻塞：补传本机材料本体，让其它设备也能预览与导出真实图片
        if (currentTab === 'room') { roomList(); roomStartPoll(); }
        clearInterval(online.pollTimer);
        online.pollTimer = setInterval(onlinePoll, 6000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) onlinePoll(); });
        window.addEventListener('online', onlinePoll);
        toast('已连接多端共享：单据与公告将在各设备间自动同步');
      });
    }).catch(function () {
      // 纯静态托管（无 /api 后端）：安静降级为纯本地模式，不打扰用户
    });
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    var t = 'light';
    try { t = localStorage.getItem(K_THEME) || 'light'; } catch (e) { }
    document.documentElement.dataset.theme = t;
    $('themeBtn').textContent = t === 'dark' ? '切换浅色' : '切换深色';
  }
  function toggleTheme() {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    $('themeBtn').textContent = next === 'dark' ? '切换浅色' : '切换深色';
    try { localStorage.setItem(K_THEME, next); } catch (e) { }
  }

  /* ---------- 事件委托 ---------- */
  document.addEventListener('click', function (e) {
    if (e.target.id === 'mask') { closeDrawer(); return; }
    if (e.target.id === 'modalMask') { closeModal(); return; }
    var el = e.target.closest('[data-act]');
    if (!el) {
      if (e.target.classList.contains('rowchk')) return;
      var tr = e.target.closest('tr[data-id]');
      if (tr) openDrawer(tr.dataset.id, currentTab === 'audit' ? 'audit' : 'track');
      return;
    }
    var act = el.dataset.act, id = el.dataset.id;
    try {
      /* 下载类操作：在用户手势内准备桌面目录，download() 会等授权完成后再写文件 */
      if (/^(exp1|exportSel|exportAll|exportJSON|exportSnap|downloadOrig|roomDownload)$/.test(act)) prepareDownloadDir();
      switch (act) {
        case 'tab': switchTab(el.dataset.tab); break;
        case 'theme': toggleTheme(); break;
        case 'toggleSecret': {
          var sec = document.getElementById(el.dataset.for);
          if (sec) {
            var masked = sec.classList.toggle('secret');
            el.textContent = masked ? '显示' : '隐藏';
          }
          break;
        }
        case 'loginOpen': openLogin(); break;
        case 'privacyLink': e.preventDefault(); openPrivacy(); break;
        case 'loginSubmit': loginSubmit(); break;
        case 'logout': logout(); break;
        case 'modalClose': closeModal(); break;
        case 'modalOk': { var f = _modalYes; closeModal(); if (f) f(); break; }
        case 'open': e.stopPropagation(); openDrawer(id, currentTab === 'audit' ? 'audit' : 'track'); break;
        case 'closeDrawer': closeDrawer(); break;
        case 'viewMat': e.stopPropagation(); viewMat(el.dataset.k, Number(el.dataset.i)); break;
        case 'exp1': {
          e.stopPropagation();
          var rid = id || currentId;
          var rec = state.records.find(function (x) { return x.id === rid; });
          if (rec) exportRecords([rec]); else toast('请先打开一条单据');
          break;
        }
        case 'exportSel': exportRecords(state.records.filter(function (r) { return selected.has(r.id); })); break;
        case 'exportAll': exportRecords(currentExportList()); break;
        case 'submitForm': submitForm(); break;
        case 'submitReset': resetForm(); toast('表单已重置'); break;
        case 'delMat': delMat(el.dataset.key, Number(el.dataset.i)); break;
        case 'unlock': unlock(el.dataset.target); break;
        case 'roleLogout': roleLogout(); break;
        case 'toggleStage': toggleStage(el.dataset.k); break;
        case 'rejectOpen': rejectOpen(); break;
        case 'rejectConfirm': rejectConfirm(); break;
        case 'deleteRec': deleteRec(); break;
        case 'downloadOrig': downloadOrig(el.dataset.k, Number(el.dataset.i)); break;
        case 'unlockDataAdmin': unlockDataAdmin(); break;
        case 'dataRoleLogout': dataRoleLogout(); break;
        case 'deleteAdminRec': deleteAdminRec(id); break;
        case 'deleteAdminSelected': deleteAdminSelected(); break;
        case 'pickDesktop': dirPromise = null; dirDeclinedAt = 0; pickDesktopDir(false); break;
        case 'resetDownload': resetDownloadDir(); break;
        case 'annAdd': annEditor(''); break;
        case 'annEdit': annEditor(id); break;
        case 'annDel': annDel(id); break;
        case 'annSave': annSave(id); break;
        case 'annReadAll': annReadAll(); break;
        case 'exportJSON': exportJSON(); break;
        case 'importJSON': $('importJsonFile').click(); break;
        case 'exportSnap': exportSnapshot(); break;
        case 'importSnap': $('importSnapFile').click(); break;
        case 'cleanup': cleanupExpired(); break;
        case 'clearAll': clearAll(); break;
        case 'roomJoin': roomJoin(id || null); break;
        case 'roomCreate': roomCreate('custom'); break;
        case 'roomRandom': roomCreate('random'); break;
        case 'roomRefresh': roomList(); break;
        case 'roomLeave': roomLeave(); break;
        case 'roomClose': roomClose(); break;
        case 'roomSend': roomSend(); break;
        case 'roomCopy': roomCopy(); break;
        case 'roomDownload': roomDownload(el.dataset.key, el.dataset.name); break;
        case 'fbSubmit': fbSubmit(); break;
        case 'serviceUnlockOpen': serviceUnlockOpen(); break;
        case 'svcUnlock': serviceUnlock(); break;
        case 'svcBack': svcView('serviceUserView'); break;
        case 'svcLogout': serviceLogout(); break;
        case 'svcRefresh': feedbackLoad().then(renderService).catch(function (e) { toast(e.message); }); break;
        case 'fbStatus': fbStatus(id, el.dataset.status); break;
      }
    } catch (err) { toast('操作失败：' + (err && err.message ? err.message : '未知错误')); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'wSelectAll') {
      var rows = workFiltered();
      if (t.checked) rows.forEach(function (r) { selected.add(r.id); });
      else rows.forEach(function (r) { selected.delete(r.id); });
      renderWork();
    } else if (t.classList.contains('rowchk')) {
      if (t.checked) selected.add(t.dataset.id); else selected.delete(t.dataset.id);
      renderWork();
    } else if (t.classList.contains('adchck')) {
      if (t.checked) adminSelected.add(t.dataset.id); else adminSelected.delete(t.dataset.id);
      var ops = $('adminRecOps'); if (ops) ops.hidden = !adminSelected.size;
    } else if (t.id === 'wStage' || t.id === 'wType') renderWork();
    else if (t.id === 'hFilter') renderHistory();
    else if (t.id === 'aFilter') renderAudit();
    else if (t.id === 'fType' || t.id === 'fClothing') renderFormMats();
    else if (t.dataset.mat) onMatFiles(t);
    else if (t.id === 'drawerAddFile') onDrawerFiles(t);
    else if (t.id === 'importJsonFile' && t.files && t.files[0]) { importJSON(t.files[0]); t.value = ''; }
    else if (t.id === 'importSnapFile' && t.files && t.files[0]) { importSnapshot(t.files[0]); t.value = ''; }
    else if (t.id === 'roomFile' && t.files && t.files[0]) { roomSendFile(t.files[0]); t.value = ''; }
  });
  /* ---------- 输入法（IME）友好 ----------
   * 中文拼音组合期间不触发筛选/重绘、不响应 Esc，避免候选词被打断或弹窗被误关。
   * 组合结束后统一补一次筛选；列表刷新加 120ms 防抖，减少输入时的重排。 */
  var composing = false, filterTimer = null;
  function scheduleFilter(id) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      if (id === 'wSearch') renderWork();
      else if (id === 'hSearch') renderHistory();
    }, 120);
  }
  function inComposition(e) {
    return composing || (e && (e.isComposing || e.keyCode === 229));
  }
  document.addEventListener('compositionstart', function () { composing = true; });
  document.addEventListener('compositionend', function (e) {
    composing = false;
    var id = e.target && e.target.id;
    if (id === 'wSearch' || id === 'hSearch') scheduleFilter(id);
  });
  document.addEventListener('input', function (e) {
    if (inComposition(e)) return;
    var id = e.target && e.target.id;
    if (id === 'wSearch' || id === 'hSearch') scheduleFilter(id);
    else if (id === 'fTotal') $('fTotalFmt').textContent = fmtMoney(e.target.value);
  });
  document.addEventListener('keydown', function (e) {
    if (inComposition(e)) return;   // 组合中按 Esc 是「取消候选词」，不关闭弹窗
    if (e.key === 'Enter' && e.target && e.target.id === 'roomText') { e.preventDefault(); roomSend(); return; }
    if (e.key === 'Escape') { closeModal(); closeDrawer(); }
  });

  /* ---------- 启动 ---------- */
  function init() {
    initFormSelects();
    applyTheme();
    loadDownloadDir();
    loadState();
    roomRestore();
    /* 首次启动不再生成任何演示单据；历史遗留的演示记录会被一次性清理，
     * 其墓碑随下一次同步推送，让其它设备上的演示记录也一并消失。 */
    if (stripDemoData()) saveState();
    var ready = Promise.resolve();
    ready.then(function () {
      resetForm();
      renderAll();
      switchTab('work');
      initOnlineShare();
      try {
        if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
          navigator.serviceWorker.register('./sw.js').catch(function () { });
        }
      } catch (err) { }
    }).catch(function (err) {
      hideProgress(); toast('初始化失败：' + (err && err.message ? err.message : '未知错误'));
      renderAll();
    });
  }
  init();
})();
