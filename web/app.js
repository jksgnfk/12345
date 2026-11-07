/* ============================================================
 * 宸阳书院报销系统 · 网页版主逻辑
 * 功能对齐小程序 8 个页面：登录 / 首页工作台 / 提交 / 进度 /
 * 历史 / 审核 / 详情 / 公告，另加数据管理与一键导出。
 * 数据：localStorage（元数据）+ IndexedDB（材料文件本体），零后端。
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
  var ADMIN_KEY = '社畜', AUDIT_KEY = '天选打工人';
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
  function download(bytes, filename, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
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
    });
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
  var state = { records: [], announcements: [], user: null, role: null, lastRead: 0, sync: { url: '', token: '' } };
  var selected = new Set(), currentId = null, currentTab = 'work', formFiles = {};
  var pgDone = 0, pgTotal = 1, _modalYes = null;

  function cleanRec(r) {
    return JSON.parse(JSON.stringify(r, function (k, v) { return k === '_buf' ? undefined : v; }));
  }
  function saveState() {
    try {
      localStorage.setItem(K_STATE, JSON.stringify({
        version: 2,
        records: state.records.map(cleanRec),
        announcements: state.announcements,
        user: state.user, role: state.role, lastRead: state.lastRead,
        sync: state.sync
      }));
    } catch (e) { toast('本地存储写入失败：' + (e && e.message ? e.message : '容量不足')); }
  }
  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(K_STATE); } catch (e) { }
    if (!raw) return false;
    try {
      var s = JSON.parse(raw);
      state.records = Array.isArray(s.records) ? s.records : [];
      state.announcements = Array.isArray(s.announcements) ? s.announcements : [];
      state.user = s.user || null;
      state.role = s.role || null;
      state.lastRead = Number(s.lastRead) || 0;
      state.sync = s.sync || { url: '', token: '' };
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 演示数据（字段与小程序 submit.js 一致） ---------- */
  function mkDemo() {
    var DAY = 86400000, now = Date.now();
    var defs = [
      { id: 'R20261028001', reason: '迎新晚会物资采购', name: '张三', dept: '学生会', type: '活动', total: 1280.50, pay: 0, stage: 4, days: 10, mats: { invoice: 2, plan: 1, pay: 1, purchase: 1 }, note: '舞台装饰、道具与耗材' },
      { id: 'R20261101002', reason: '社团骨干培训资料打印', name: '李悦', dept: '项目部', type: '培训', total: 356.00, pay: 0, stage: 1, days: 6, mats: { invoice: 1, plan: 1, pay: 1 }, note: '培训手册 40 份' },
      { id: 'R20261102003', reason: '赴杭参赛差旅报销', name: '王浩', dept: '外联部', type: '差旅', total: 892.00, pay: 1, stage: 2, days: 5, mats: { invoice: 2, pay: 1, proof: 1 }, note: '高铁往返 + 住宿两晚' },
      { id: 'R20261103004', reason: '办公室耗材采购', name: '陈曦', dept: '办公室', type: '采购', total: 214.80, pay: 0, stage: 0, days: 4, mats: { invoice: 1, pay: 1, purchase: 1 }, note: '' },
      { id: 'R20261104005', reason: '志愿者服装采购', name: '赵宁', dept: '文艺部', type: '采购', total: 1680.00, pay: 4, stage: 1, days: 3, mats: { invoice: 1, claim: 1, pay: 1 }, note: '含服装领用清单', rejected: true, rejectReason: '发票缺少购买方抬头，请补充后重新提交。' },
      { id: 'R20261105006', reason: '讲座嘉宾接待费用', name: '孙淼', dept: '学术部', type: '其他', total: 480.00, pay: 0, stage: 3, days: 2, mats: { invoice: 1, pay: 1, other: 1 }, note: '含签到表扫描件' }
    ];
    return defs.map(function (d) {
      var createdAt = now - d.days * DAY, materials = {};
      Object.keys(d.mats).forEach(function (k) {
        materials[k] = Array.from({ length: d.mats[k] }, function (_, i) {
          return {
            type: (k === 'plan' || k === 'claim' || k === 'other') ? 'file' : 'image',
            name: MATNAME[k] + ' ' + (i + 1),
            ext: (k === 'plan' || k === 'other') ? 'txt' : (k === 'claim' ? 'csv' : 'png'),
            path: '', fileID: 'demo://' + d.id + '/' + k + '/' + i, key: '', size: 0
          };
        });
      });
      var stageLog = {};
      for (var s = 0; s <= d.stage; s++) stageLog[s] = createdAt + s * DAY;
      return {
        id: d.id, userId: d.name, name: d.name, sid: '', academy: '宸阳书院', dept: d.dept, phone: '',
        reason: d.reason, type: d.type, payMethod: PAY_METHODS[d.pay], clothing: false, total: d.total,
        note: d.note, materials: materials, stage: d.stage, rejected: !!d.rejected,
        rejectReason: d.rejectReason || '', rejectAt: d.rejected ? createdAt + DAY : 0,
        rejectBy: d.rejected ? '审核员' : '', rejectLog: [],
        stageLog: stageLog, createdAt: createdAt, updatedAt: createdAt + d.stage * DAY
      };
    });
  }
  function mkDemoAnnouncements() {
    var now = Date.now(), D = 86400000;
    return [
      { _id: genId('A'), title: '关于 11 月报销材料提交规范的通知', content: '一、发票需填写完整购买方抬头与纳税人识别号。\n二、活动策划案须附预算表，支付截图需清晰可辨。\n三、单笔最多提交 50 份材料，请按需整理后上传。', pinned: true, createdAt: now - 2 * D, updatedAt: now - 2 * D },
      { _id: genId('A'), title: '计财处月末结账时间提醒', content: '本月最后三个工作日暂停接收新的报销单，请各项目组提前安排提交时间。', pinned: false, createdAt: now - D, updatedAt: now - D }
    ];
  }

  /* 演示材料生成：让导出包内含真实可打开的文件 */
  function pngBuffer(lines) {
    return new Promise(function (resolve) {
      try {
        var c = document.createElement('canvas'); c.width = 720; c.height = 420;
        var g = c.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 720, 420);
        g.strokeStyle = '#1faa6b'; g.lineWidth = 5; g.strokeRect(14, 14, 692, 392);
        g.fillStyle = '#1faa6b'; g.fillRect(14, 14, 692, 62);
        g.fillStyle = '#ffffff'; g.font = '500 24px "PingFang SC","Microsoft YaHei",sans-serif';
        g.fillText('宸阳书院报销系统 · 材料示意', 36, 55);
        g.fillStyle = '#16352a'; g.font = '500 27px "PingFang SC","Microsoft YaHei",sans-serif';
        g.fillText(lines[0] || '', 40, 128);
        g.font = '17px "PingFang SC","Microsoft YaHei",sans-serif'; g.fillStyle = '#5b7a6c';
        (lines.slice(1) || []).forEach(function (t, i) { g.fillText(t, 40, 172 + i * 32); });
        g.fillStyle = '#9ab5a7'; g.font = '14px sans-serif';
        g.fillText('离线演示数据 · 非真实票据', 40, 382);
        c.toBlob(function (b) {
          if (!b) { resolve(textBuffer('图片生成失败')); return; }
          b.arrayBuffer().then(resolve).catch(function () { resolve(textBuffer('图片生成失败')); });
        }, 'image/png');
      } catch (e) { resolve(textBuffer('图片生成失败：' + e.message)); }
    });
  }
  function materialBuffer(rec, key, f) {
    if (f.ext === 'png') return pngBuffer([
      (MATNAME[key] || key) + ' · ' + f.name,
      '单据编号：' + rec.id, '报销事由：' + rec.reason,
      '提交人：' + rec.name + '（' + rec.dept + '）',
      '报销金额：' + fmtMoney(rec.total), '材料类别：' + (MATNAME[key] || key)
    ]);
    if (f.ext === 'csv') return Promise.resolve(textBuffer('\uFEFF序号,物品,数量,领用人\n1,志愿者上衣,20,赵宁\n2,志愿者帽子,20,赵宁\n'));
    return Promise.resolve(textBuffer(
      '宸阳书院报销系统 · ' + (MATNAME[key] || key) + '\n' +
      '----------------------------------------\n' +
      '单据编号：' + rec.id + '\n报销事由：' + rec.reason + '\n' +
      '提交人：' + rec.name + '（' + rec.dept + '）\n报销类型：' + rec.type + '\n' +
      '报销金额：' + fmtMoney(rec.total) + '\n材料名称：' + f.name + '\n' +
      '----------------------------------------\n本文件为离线演示数据，用于验证网页版一键导出功能。\n'
    ));
  }
  function seedDemo() {
    state.records = mkDemo();
    state.announcements = mkDemoAnnouncements();
    state.lastRead = 0;
    var jobs = [];
    state.records.forEach(function (rec) {
      Object.keys(rec.materials || {}).forEach(function (k) {
        (rec.materials[k] || []).forEach(function (f) {
          jobs.push(materialBuffer(rec, k, f).then(function (buf) {
            var key = uid();
            return putFile(key, buf).then(function () {
              f.key = key;
              f.size = buf.byteLength || buf.length || 0;
            });
          }));
        });
      });
    });
    return Promise.all(jobs).then(function () { saveState(); });
  }

  /* ---------- 筛选 ---------- */
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
    if (!$('syncUrl').value) $('syncUrl').value = state.sync.url || '';
    if (!$('syncToken').value) $('syncToken').value = state.sync.token || '';
    var files = 0, size = 0;
    state.records.forEach(function (r) {
      Object.keys(r.materials || {}).forEach(function (k) {
        (r.materials[k] || []).forEach(function (f) { files++; size += Number(f.size) || 0; });
      });
    });
    $('storeInfo').innerHTML = '单据 ' + state.records.length + ' 条 · 公告 ' + state.announcements.length +
      ' 条 · 材料 ' + files + ' 份（约 ' + (size / 1024 / 1024).toFixed(2) + ' MB）<br>' +
      '存储：localStorage（元数据）+ IndexedDB（文件本体）· 数据不会自动上传任何服务器。';
  }
  function renderAll() {
    renderHeader(); renderWork(); renderSubmit(); renderTrack();
    renderHistory(); renderAudit(); renderAnnounce(); renderData(); renderBadges();
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
    html += '<div class="sec"><h3>材料清单（' + countMats(r) + ' 份 / 上限 ' + MAX_FILES + '）</h3>';
    var keys = Object.keys(r.materials || {});
    if (!keys.length) html += '<div class="empty">暂无材料</div>';
    keys.forEach(function (k) {
      (r.materials[k] || []).forEach(function (f) {
        var sz = f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : '云端';
        html += '<div class="mat"><span class="n">' + esc((MATNAME[k] || k) + ' · ' + f.name) + '</span>' +
          '<span class="m">' + esc((f.ext || 'bin').toUpperCase() + ' · ' + sz) + '</span></div>';
      });
    });
    html += '</div>';
    $('drawerBody').innerHTML = html;
    var bar = $('drawerAuditBar');
    if (m === 'audit' && isAuditor()) {
      bar.hidden = false;
      bar.innerHTML = '<h4>流程操作（点击阶段节点推进 / 回退）</h4><div class="stage-btns">' +
        STAGES.map(function (s) {
          return '<button class="btn ' + (Number(r.stage) === s.k && !r.rejected ? 'primary' : 'ghost') + ' sm" data-act="toggleStage" data-k="' + s.k + '">' + esc(s.name) + '</button>';
        }).join('') + '</div><h4>审核处理</h4><div class="stage-btns">' +
        '<button class="btn amber sm" data-act="rejectOpen">退回申请</button>' +
        '<button class="btn danger sm" data-act="deleteRec">删除单据</button>' +
        '<button class="btn primary sm" data-act="exp1">一键导出</button></div>';
    } else { bar.hidden = true; bar.innerHTML = ''; }
    $('mask').hidden = false; $('drawer').hidden = false;
  }
  function closeDrawer() { $('mask').hidden = true; $('drawer').hidden = true; currentId = null; }

  /* ---------- 弹窗 ---------- */
  function openModal() { $('modalMask').hidden = false; $('modal').hidden = false; }
  function closeModal() { $('modalMask').hidden = true; $('modal').hidden = true; _modalYes = null; }
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
      '<p class="hint">用户名、书院、部门均为<b>手动填写</b>，网页版不获取任何微信资料，也不上传数据。</p>' +
      '<div class="frow"><label class="req">用户名</label><input class="fin" id="lgName" maxlength="40" value="' + esc(u.username) + '" placeholder="请输入姓名"></div>' +
      '<div class="frow"><label>书院</label><input class="fin" id="lgAcademy" maxlength="40" value="' + esc(u.academy) + '" placeholder="如：宸阳书院"></div>' +
      '<div class="frow"><label>部门</label><input class="fin" id="lgDept" maxlength="40" value="' + esc(u.dept) + '" placeholder="如：学生会"></div>' +
      '<label class="chk" style="margin-top:12px"><input type="checkbox" id="lgAgree"> 我已阅读并同意 <a href="#" data-act="privacyLink">《隐私协议》</a>（需主动勾选）</label>';
    $('modalFoot').innerHTML = '<button class="btn ghost" data-act="logout">退出登录</button>' +
      '<button class="btn primary" data-act="loginSubmit">进入系统</button>';
    openModal();
  }
  function openPrivacy() {
    $('modalTitle').textContent = '隐私协议（网页版）';
    $('modalBody').innerHTML = '<p class="hint">1. 本网页版仅采集您<b>手动填写</b>的用户名、书院、部门，以及您主动上传的报销材料；不获取微信昵称、头像、openid 等任何微信资料。<br>' +
      '2. 所有数据默认仅保存在当前浏览器的 localStorage 与 IndexedDB 中，不会自动上传服务器；仅在您主动配置「云同步」并点击上传时才会发送到您填写的网关地址。<br>' +
      '3. 您可通过「数据管理」导出备份、清理或清空全部本地数据。<br>' +
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

  /* ---------- 角色解锁 ---------- */
  function unlock(target) {
    var key = ((target === 'history' ? $('histKey').value : $('audKey').value) || '').trim();
    var role = key === ADMIN_KEY ? 'admin' : (key === AUDIT_KEY ? 'audit' : null);
    if (!role) { toast('密钥错误，请重新输入'); return; }
    if (target === 'history' && role !== 'admin') { toast('全部历史需最高管理密钥'); return; }
    state.role = role; saveState(); renderAll(); toast('已解锁：' + roleLabel(role));
  }
  function quickAdmin() { state.role = 'admin'; saveState(); renderAll(); toast('已切换为最高管理（本地演示）'); }
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
    L.push('数据来源：本浏览器本地存储（localStorage + IndexedDB）');
    L.push('');
    L.push('目录与命名规则');
    L.push('  单条导出：00-单据信息.txt + 01-发票.png 等，按材料类别顺序编号');
    L.push('  批量导出：每条单据一个子目录，根目录附 汇总.csv 与本说明');
    L.push('  命名口径与小程序 utils/exporter.js 一致：序号-材料类别.扩展名');
    L.push('  中文文件名使用 UTF-8 标志位，Windows / macOS 均可正常解压');
    L.push('');
    if (failures.length) {
      L.push('未能包含的文件（' + failures.length + ' 项）');
      failures.forEach(function (f) { L.push('  - ' + f); });
      L.push('  原因：该材料仅含云端 fileID 或外部路径，本地无文件本体。');
      L.push('  处理：在网页版详情页「添加本地材料」，或导入完整快照后再导出。');
    } else L.push('全部材料均已包含，无跳过项。');
    L.push('');
    L.push('注：ZIP 采用 STORE 方式（不压缩），以保证中文名兼容与打包速度。');
    return L.join('\n');
  }
  function collectEntries(rec, prefix, failures) {
    var out = [{ name: (prefix ? prefix + '/' : '') + '00-单据信息.txt', buffer: textBuffer(recordInfo(rec)) }];
    var idx = 0;
    var keys = Object.keys(rec.materials || {});
    return keys.reduce(function (chain, k) {
      return chain.then(function () {
        return (rec.materials[k] || []).reduce(function (ch, f) {
          return ch.then(function () {
            idx++;
            return fileBuffer(f).then(function (buf) {
              if (!buf || (buf.byteLength || buf.length || 0) === 0) {
                failures.push(rec.id + ' / ' + (MATNAME[k] || k) + ' / ' + (f.name || '文件') + '（仅含云端 fileID 或路径，无本地内容）');
                bump(); return;
              }
              var ext = (f.ext && f.ext !== 'IMG') ? String(f.ext).toLowerCase() : (guessExt(f.path || f.name || '') || 'bin');
              var nm = pad(idx) + '-' + sanitize(MATNAME[k] || k) + '.' + ext;
              out.push({ name: prefix ? prefix + '/' + nm : nm, buffer: buf });
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
      entries.push({ name: '导出说明.txt', buffer: textBuffer(buildReadme(list, batch ? '批量导出' : '单条导出', failures, entries.length + 1)) });
      var bytes = buildZip(entries);
      var fn = batch ? ('报销材料-批量-' + dateStr() + '.zip')
        : ('报销材料-' + sanitize(list[0].reason || '单据') + '-' + sanitize(list[0].id) + '.zip');
      setProgress(100, '打包完成，正在下载');
      download(bytes, fn);
      toast('已导出 ' + list.length + ' 条单据 / ' + entries.length + ' 个文件' +
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
  function resetDemo() {
    confirmDialog('重置演示数据', '将用内置演示数据覆盖当前所有内容。', function () {
      Promise.all(state.records.map(releaseRecordFiles)).then(function () {
        state.records = []; state.announcements = []; selected.clear();
        showProgress('正在准备演示数据…');
        return seedDemo();
      }).then(function () {
        renderAll(); hideProgress(); toast('已重置为演示数据');
      }).catch(function (e) { hideProgress(); toast('重置失败：' + e.message); });
    });
  }

  /* ---------- 云同步（可选，对应多端方案 L1 的网关契约） ---------- */
  function syncCfg() {
    state.sync.url = ($('syncUrl').value || '').trim();
    state.sync.token = ($('syncToken').value || '').trim();
    saveState();
    return state.sync;
  }
  function syncStatus(t) { $('syncStatus').textContent = t; }
  function syncCall(path, extra) {
    var c = syncCfg();
    if (!c.url) return Promise.reject(new Error('请先填写网关地址'));
    var base = c.url.replace(/\/+$/, '');
    return fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: c.token }, extra || {}))
    }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error('HTTP ' + res.status));
      return res.json();
    }).then(function (j) {
      if (j && j.ok === false) return Promise.reject(new Error(j.msg || '云端拒绝请求'));
      return j;
    });
  }
  function syncTest() {
    syncStatus('正在连接…');
    syncCall('/sync/ping').then(function () {
      syncStatus('连接成功 ✓ 网关可用（' + new Date().toLocaleTimeString('zh-CN') + '）');
    }).catch(function (e) {
      syncStatus('连接失败：' + e.message + '。纯本地模式仍可正常使用，详见《多端使用方案》。');
    });
  }
  function syncPull() {
    syncStatus('正在拉取…');
    syncCall('/sync/pull').then(function (j) {
      var recs = Array.isArray(j.records) ? j.records : [];
      confirmDialog('拉取云端数据', '云端返回 ' + recs.length + ' 条单据，将覆盖本机当前数据。', function () {
        state.records = recs.map(normalizeRecord).filter(Boolean);
        state.announcements = Array.isArray(j.announcements) ? j.announcements : state.announcements;
        selected.clear(); saveState(); renderAll();
        syncStatus('已拉取 ' + state.records.length + ' 条单据（' + new Date().toLocaleTimeString('zh-CN') + '）');
        toast('云端数据已拉取');
      });
    }).catch(function (e) { syncStatus('拉取失败：' + e.message); });
  }
  function syncPush() {
    syncStatus('正在上传…');
    syncCall('/sync/push', {
      records: state.records.map(cleanRec), announcements: state.announcements
    }).then(function () {
      syncStatus('上传成功 ✓ ' + state.records.length + ' 条单据（' + new Date().toLocaleTimeString('zh-CN') + '）');
      toast('本地数据已上传云端');
    }).catch(function (e) { syncStatus('上传失败：' + e.message); });
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
      switch (act) {
        case 'tab': switchTab(el.dataset.tab); break;
        case 'theme': toggleTheme(); break;
        case 'loginOpen': openLogin(); break;
        case 'privacyLink': e.preventDefault(); openPrivacy(); break;
        case 'loginSubmit': loginSubmit(); break;
        case 'logout': logout(); break;
        case 'modalClose': closeModal(); break;
        case 'modalOk': { var f = _modalYes; closeModal(); if (f) f(); break; }
        case 'open': e.stopPropagation(); openDrawer(id, currentTab === 'audit' ? 'audit' : 'track'); break;
        case 'closeDrawer': closeDrawer(); break;
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
        case 'quickAdmin': quickAdmin(); break;
        case 'roleLogout': roleLogout(); break;
        case 'toggleStage': toggleStage(el.dataset.k); break;
        case 'rejectOpen': rejectOpen(); break;
        case 'rejectConfirm': rejectConfirm(); break;
        case 'deleteRec': deleteRec(); break;
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
        case 'resetDemo': resetDemo(); break;
        case 'syncTest': syncTest(); break;
        case 'syncPull': syncPull(); break;
        case 'syncPush': syncPush(); break;
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
    } else if (t.id === 'wStage' || t.id === 'wType') renderWork();
    else if (t.id === 'hFilter') renderHistory();
    else if (t.id === 'aFilter') renderAudit();
    else if (t.id === 'fType' || t.id === 'fClothing') renderFormMats();
    else if (t.dataset.mat) onMatFiles(t);
    else if (t.id === 'drawerAddFile') onDrawerFiles(t);
    else if (t.id === 'importJsonFile' && t.files && t.files[0]) { importJSON(t.files[0]); t.value = ''; }
    else if (t.id === 'importSnapFile' && t.files && t.files[0]) { importSnapshot(t.files[0]); t.value = ''; }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'wSearch') renderWork();
    else if (e.target.id === 'hSearch') renderHistory();
    else if (e.target.id === 'fTotal') $('fTotalFmt').textContent = fmtMoney(e.target.value);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeDrawer(); }
  });

  /* ---------- 启动 ---------- */
  function init() {
    initFormSelects();
    applyTheme();
    var had = loadState();
    var ready = had ? Promise.resolve() : (function () {
      showProgress('正在准备演示数据…');
      return seedDemo().then(hideProgress);
    })();
    ready.then(function () {
      resetForm();
      renderAll();
      switchTab('work');
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
