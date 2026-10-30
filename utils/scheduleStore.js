// utils/scheduleStore.js
// 日程组件本地存储数据层 —— 本地（wx.Storage）为唯一真源，不依赖云端，
// 行为与原 HTML 版 localStorage 一致，规避"云端不可用时数据丢失"的隐患。
const KEY = 'schedule-state-v1';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmt(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function todayStr() { return fmt(new Date()); }

function addDays(s, n) {
  const d = parseDate(s) || new Date();
  d.setDate(d.getDate() + n);
  return fmt(d);
}

// 周一=0 ... 周日=6
function weekdayOf(s) {
  const d = parseDate(s);
  if (!d) return 0;
  return (d.getDay() + 6) % 7;
}

// b - a（天）
function diffDays(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function isOverdue(todo, today) {
  if (todo.done || !todo.due) return false;
  return diffDays(todo.due, today) < 0;
}

function dueLabel(todo, today) {
  if (!todo.due) return '无日期';
  if (todo.done) return '已完成';
  const d = diffDays(todo.due, today);
  if (d < 0) return d === -1 ? '昨天' : '逾期 ' + (-d) + ' 天';
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  return '还剩 ' + d + ' 天';
}

function genId() {
  return 's_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function defaultProject() {
  return { id: genId(), name: '默认项目', start: '', end: '', members: [], todos: [], steps: [] };
}

function defaultState() {
  const p = defaultProject();
  return {
    selectedDate: todayStr(),
    calCursor: null,
    todos: [],
    weekly: [],
    weeklySkip: {},
    projects: [p],
    activeProject: p.id,
    mode: 'normal'
  };
}

function load() {
  let st = null;
  try { st = wx.getStorageSync(KEY); } catch (e) { st = null; }
  if (!st || typeof st !== 'object') st = defaultState();
  const def = defaultState();
  for (const k in def) if (!(k in st)) st[k] = def[k];
  if (!st.projects || !st.projects.length) st.projects = [defaultProject()];
  if (!st.activeProject || !st.projects.some(p => p.id === st.activeProject)) {
    st.activeProject = st.projects[0].id;
  }
  if (!st.selectedDate) st.selectedDate = todayStr();
  if (!st.weeklySkip || typeof st.weeklySkip !== 'object') st.weeklySkip = {};
  return st;
}

function save(st) {
  try { wx.setStorageSync(KEY, st); } catch (e) { console.error('schedule save fail', e); }
}

// 周常模板按选中日幂等注入为待办实例（带 weeklyId 防重）
function materializeWeekly(st, dateStr) {
  if (!dateStr) return;
  const wd = weekdayOf(dateStr);
  const skip = st.weeklySkip[dateStr] || [];
  st.weekly.forEach(t => {
    if (!t.enabled) return;
    if (t.days.indexOf(wd) < 0) return;
    if (skip.indexOf(t.id) >= 0) return;
    const exists = st.todos.some(td => td.weeklyId === t.id && td.due === dateStr);
    if (exists) return;
    st.todos.push({
      id: genId(), text: t.text, priority: t.priority, category: t.category,
      due: dateStr, done: false, createdAt: Date.now(),
      published: true, weeklyId: t.id, reminded: true
    });
  });
}

function toggleWeeklySkip(st, dateStr, weeklyId) {
  const skip = st.weeklySkip[dateStr] || [];
  const i = skip.indexOf(weeklyId);
  if (i >= 0) {
    skip.splice(i, 1);
    if (!skip.length) delete st.weeklySkip[dateStr];
    else st.weeklySkip[dateStr] = skip;
    materializeWeekly(st, dateStr);
  } else {
    skip.push(weeklyId);
    st.weeklySkip[dateStr] = skip;
    st.todos = st.todos.filter(td => !(td.weeklyId === weeklyId && td.due === dateStr));
  }
}

module.exports = {
  KEY, fmt, parseDate, todayStr, addDays, weekdayOf, diffDays,
  isOverdue, dueLabel, genId, defaultState, defaultProject,
  load, save, materializeWeekly, toggleWeeklySkip
};
