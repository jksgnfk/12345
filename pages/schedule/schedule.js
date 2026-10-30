// pages/schedule/schedule.js
const S = require('../../utils/scheduleStore.js');

const PRIO = [
  { v: 'S', label: 'S 紧急' }, { v: 'A', label: 'A 高' },
  { v: 'B', label: 'B 中' }, { v: 'C', label: 'C 低' }
];
const CATS = ['学习', '社团', '生活', '健康', '其他'];
const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const WEEK_WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const rankOf = p => { const i = PRIO.findIndex(x => x.v === p); return i < 0 ? 2 : i; };

function fmtLabel(s) {
  const d = S.parseDate(s); if (!d) return s || '';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

Page({
  data: {
    tab: 'todo', today: '', selectedDate: '', selLabel: '', selWeekday: '',
    newText: '', newDue: '', prioIndex: 2, catIndex: 0,
    prioOptions: PRIO, catOptions: CATS, dayNames: DAY_NAMES,
    todosView: [], undatedView: [],
    calTitle: '', calCells: [],
    weekTitle: '', weekDays: [],
    weeklyList: [],
    wText: '', wDays: [false, false, false, false, false, false, false], wPrioIndex: 2, wCatIndex: 0, wTime: '',
    projects: [], activeProj: {},
    mName: '', mRole: '', pTodo: '', pStep: '',
    reminders: []
  },

  onLoad() {
    this.st = S.load();
    if (!this.st.calCursor) this.st.calCursor = this.st.selectedDate.slice(0, 7);
    // 归一化：项目成员/待办补唯一 id（旧数据可能缺失）
    this.st.projects.forEach(p => {
      p.members.forEach(m => { if (!m.id) m.id = S.genId(); });
      p.todos.forEach(t => { if (!t.id) t.id = S.genId(); });
    });
    this.refresh();
  },

  // ===== 统一刷新 =====
  refresh() {
    const st = this.st;
    const today = S.todayStr();
    S.materializeWeekly(st, st.selectedDate);
    const viewOf = t => ({
      id: t.id, text: t.text, priority: t.priority, category: t.category,
      due: t.due, dueLabel: S.dueLabel(t, today), overdue: S.isOverdue(t, today),
      done: t.done, weekly: !!t.weeklyId
    });
    const sortTodos = arr => arr.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || rankOf(a.priority) - rankOf(b.priority));

    // 待办
    const todosView = sortTodos(st.todos.filter(t => t.due === st.selectedDate).map(viewOf));
    const undatedView = sortTodos(st.todos.filter(t => !t.due).map(viewOf));

    // 日历
    const cur = st.calCursor || today.slice(0, 7);
    const [cy, cm] = cur.split('-').map(Number);
    const first = new Date(cy, cm - 1, 1);
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const dt = new Date(cy, cm - 1, 1 - lead + i);
      const date = S.fmt(dt);
      const wd = (dt.getDay() + 6) % 7;
      const skip = st.weeklySkip[date] || [];
      const hasWk = st.weekly.some(t => t.enabled && t.days.indexOf(wd) >= 0 && skip.indexOf(t.id) < 0);
      cells.push({
        date, day: dt.getDate(),
        out: dt.getMonth() + 1 !== cm,
        isToday: date === today, isSelected: date === st.selectedDate,
        hasOpen: st.todos.some(t => t.due === date && !t.done),
        hasDone: st.todos.some(t => t.due === date && t.done),
        hasWeekly: hasWk
      });
    }

    // 周视图
    const dow = (S.parseDate(st.selectedDate).getDay() + 6) % 7;
    const monday = S.addDays(st.selectedDate, -dow);
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const date = S.addDays(monday, i);
      weekDays.push({
        date, day: S.parseDate(date).getDate(), wd: WEEK_WD[i],
        isToday: date === today, isSelected: date === st.selectedDate,
        todos: sortTodos(st.todos.filter(t => t.due === date).map(viewOf))
      });
    }
    const wkS = S.parseDate(monday), wkE = S.parseDate(S.addDays(monday, 6));
    const weekTitle = (wkS.getMonth() + 1) + '.' + wkS.getDate() + ' – ' + (wkE.getMonth() + 1) + '.' + wkE.getDate();

    // 周常
    const weeklyList = st.weekly.map(t => ({
      id: t.id, text: t.text, priority: t.priority, category: t.category,
      time: t.time, enabled: t.enabled,
      daysLabel: t.days.length ? t.days.map(x => DAY_NAMES[x]).join(' ') : '未选'
    }));

    // 项目
    const projects = st.projects.map(p => ({ id: p.id, name: p.name, active: p.id === st.activeProject }));
    const ap = st.projects.find(p => p.id === st.activeProject) || st.projects[0];
    const doneS = ap.steps.filter(s => s.done).length;
    let periodLabel = '周期未设置', periodClass = 'y';
    if (ap.start && ap.end) {
      const ds = S.diffDays(ap.start, today), de = S.diffDays(ap.end, today);
      if (ds > 0) { periodLabel = '还有 ' + ds + ' 天开始'; periodClass = ds > 3 ? 'g' : 'y'; }
      else if (de > 0) { periodLabel = '剩余 ' + de + ' 天'; periodClass = de > 3 ? 'g' : (de > 1 ? 'y' : 'r'); }
      else if (de === 0) { periodLabel = '今日截止'; periodClass = 'r'; }
      else { periodLabel = '已结束 ' + (-de) + ' 天'; periodClass = 'r'; }
    }
    const activeProj = {
      id: ap.id, name: ap.name, start: ap.start, end: ap.end,
      periodLabel, periodClass, countLabel: '步骤 ' + doneS + '/' + ap.steps.length,
      members: ap.members, todos: ap.todos, steps: ap.steps
    };

    // 提醒
    const reminders = sortTodos(
      st.todos.filter(t => !t.done && t.due && S.diffDays(t.due, today) <= 0).map(t => {
        const v = viewOf(t); v.type = S.isOverdue(t, today) ? 'overdue' : 'today'; return v;
      })
    );

    this.setData({
      today, selectedDate: st.selectedDate,
      selLabel: fmtLabel(st.selectedDate), selWeekday: WEEK_WD[(S.parseDate(st.selectedDate).getDay() + 6) % 7],
      todosView, undatedView,
      calTitle: cy + '年' + cm + '月', calCells: cells,
      weekTitle, weekDays,
      weeklyList,
      projects, activeProj,
      reminders
    });
  },

  commit() { S.save(this.st); this.refresh(); },

  // ===== 标签 / 日期 =====
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },
  prevDay() { this.st.selectedDate = S.addDays(this.st.selectedDate, -1); this.commit(); },
  nextDay() { this.st.selectedDate = S.addDays(this.st.selectedDate, 1); this.commit(); },
  goToday() { this.st.selectedDate = S.todayStr(); this.commit(); },
  calPrev() { const [y, m] = this.st.calCursor.split('-').map(Number); const nm = m - 1 || 12; const ny = m - 1 ? y : y - 1; this.st.calCursor = ny + '-' + (nm < 10 ? '0' + nm : nm); this.commit(); },
  calNext() { const [y, m] = this.st.calCursor.split('-').map(Number); const nm = m % 12 + 1; const ny = nm === 1 ? y + 1 : y; this.st.calCursor = ny + '-' + (nm < 10 ? '0' + nm : nm); this.commit(); },
  calToday() { this.st.calCursor = S.todayStr().slice(0, 7); this.st.selectedDate = S.todayStr(); this.commit(); },
  tapCalCell(e) { this.st.selectedDate = e.currentTarget.dataset.date; this.st.calCursor = this.st.selectedDate.slice(0, 7); this.setData({ tab: 'todo' }); this.commit(); },
  tapWeekCell(e) { this.st.selectedDate = e.currentTarget.dataset.date; this.setData({ tab: 'todo' }); this.commit(); },

  // ===== 待办 =====
  onNewText(e) { this.setData({ newText: e.detail.value }); },
  onPrioChange(e) { this.setData({ prioIndex: +e.detail.value }); },
  onCatChange(e) { this.setData({ catIndex: +e.detail.value }); },
  onDueChange(e) { this.setData({ newDue: e.detail.value }); },
  addTodo() {
    const text = (this.data.newText || '').trim();
    if (!text) { wx.showToast({ title: '请输入内容', icon: 'none' }); return; }
    this.st.todos.push({
      id: S.genId(), text, priority: PRIO[this.data.prioIndex].v, category: CATS[this.data.catIndex],
      due: this.data.newDue || this.st.selectedDate, done: false, createdAt: Date.now(),
      published: true, weeklyId: null, reminded: false
    });
    this.setData({ newText: '' });
    this.commit();
  },
  toggleTodo(e) {
    const t = this.st.todos.find(x => x.id === e.currentTarget.dataset.id);
    if (t) { t.done = !t.done; this.commit(); }
  },
  delTodo(e) {
    this.st.todos = this.st.todos.filter(x => x.id !== e.currentTarget.dataset.id);
    this.commit();
  },
  assignToday(e) {
    const t = this.st.todos.find(x => x.id === e.currentTarget.dataset.id);
    if (t) { t.due = this.st.selectedDate; this.commit(); }
  },

  // ===== 周常 =====
  toggleWDay(e) {
    const day = +e.currentTarget.dataset.day; const wd = this.data.wDays.slice();
    wd[day] = !wd[day]; this.setData({ wDays: wd });
  },
  onWText(e) { this.setData({ wText: e.detail.value }); },
  onWPrio(e) { this.setData({ wPrioIndex: +e.detail.value }); },
  onWCat(e) { this.setData({ wCatIndex: +e.detail.value }); },
  onWTime(e) { this.setData({ wTime: e.detail.value }); },
  addWeekly() {
    const days = this.data.wDays.map((v, i) => v ? i : -1).filter(i => i >= 0);
    if (!this.data.wText.trim()) { wx.showToast({ title: '请输入内容', icon: 'none' }); return; }
    if (!days.length) { wx.showToast({ title: '请选择星期', icon: 'none' }); return; }
    this.st.weekly.push({
      id: S.genId(), text: this.data.wText.trim(), days, time: this.data.wTime,
      priority: PRIO[this.data.wPrioIndex].v, category: CATS[this.data.wCatIndex], enabled: true, createdAt: Date.now()
    });
    this.setData({ wText: '', wTime: '', wDays: [false, false, false, false, false, false, false] });
    this.commit();
  },
  toggleWEnabled(e) {
    const t = this.st.weekly.find(x => x.id === e.currentTarget.dataset.id);
    if (t) { t.enabled = !t.enabled; this.commit(); }
  },
  delWeekly(e) {
    this.st.weekly = this.st.weekly.filter(x => x.id !== e.currentTarget.dataset.id);
    this.commit();
  },

  // ===== 项目 =====
  selectProject(e) { this.st.activeProject = e.currentTarget.dataset.id; this.commit(); },
  newProject() {
    const p = S.defaultProject(); this.st.projects.push(p); this.st.activeProject = p.id; this.commit();
  },
  delProject() {
    if (this.st.projects.length <= 1) { wx.showToast({ title: '至少保留一个', icon: 'none' }); return; }
    this.st.projects = this.st.projects.filter(p => p.id !== this.st.activeProject);
    this.st.activeProject = this.st.projects[0].id; this.commit();
  },
  onPName(e) { const p = this._ap(); if (p) { p.name = e.detail.value; this.commit(); } },
  onPStart(e) { const p = this._ap(); if (p) { p.start = e.detail.value; this.commit(); } },
  onPEnd(e) { const p = this._ap(); if (p) { p.end = e.detail.value; this.commit(); } },
  _ap() { return this.st.projects.find(p => p.id === this.st.activeProject); },
  delPMember(e) { const p = this._ap(); p.members.splice(+e.currentTarget.dataset.idx, 1); this.commit(); },
  addPMember() {
    if (!this.data.mName.trim()) return;
    this._ap().members.push({ id: S.genId(), name: this.data.mName.trim(), role: this.data.mRole.trim() });
    this.setData({ mName: '', mRole: '' }); this.commit();
  },
  onMName(e) { this.setData({ mName: e.detail.value }); },
  onMRole(e) { this.setData({ mRole: e.detail.value }); },
  togglePTodo(e) { const p = this._ap(); p.todos[+e.currentTarget.dataset.idx].done = !p.todos[+e.currentTarget.dataset.idx].done; this.commit(); },
  addPTodo() {
    if (!this.data.pTodo.trim()) return;
    this._ap().todos.push({ id: S.genId(), text: this.data.pTodo.trim(), done: false });
    this.setData({ pTodo: '' }); this.commit();
  },
  onPTodoText(e) { this.setData({ pTodo: e.detail.value }); },
  delPTodo(e) { this._ap().todos.splice(+e.currentTarget.dataset.idx, 1); this.commit(); },
  addPStep() {
    if (!this.data.pStep.trim()) return;
    const p = this._ap(); p.steps.push({ text: this.data.pStep.trim(), done: false, no: p.steps.length + 1 });
    this.setData({ pStep: '' }); this.commit();
  },
  onPStepText(e) { this.setData({ pStep: e.detail.value }); },
  togglePStep(e) { const p = this._ap(); p.steps[+e.currentTarget.dataset.idx].done = !p.steps[+e.currentTarget.dataset.idx].done; this.commit(); },
  movePStep(e) {
    const p = this._ap(); const i = +e.currentTarget.dataset.idx, dir = +e.currentTarget.dataset.dir, j = i + dir;
    if (j < 0 || j >= p.steps.length) return;
    const tmp = p.steps[i]; p.steps[i] = p.steps[j]; p.steps[j] = tmp;
    p.steps.forEach((s, k) => s.no = k + 1); this.commit();
  },
  delPStep(e) { const p = this._ap(); p.steps.splice(+e.currentTarget.dataset.idx, 1); p.steps.forEach((s, k) => s.no = k + 1); this.commit(); },
  exportProject() {
    const p = this._ap();
    let txt = '【' + p.name + '】项目备忘\n';
    txt += '周期：' + (p.start || '?') + ' ~ ' + (p.end || '?') + '\n';
    txt += '人员：' + (p.members.map(m => m.name + (m.role ? '(' + m.role + ')' : '')).join('、') || '无') + '\n';
    txt += '待办：\n' + (p.todos.map(t => (t.done ? '[x] ' : '[ ] ') + t.text).join('\n') || '  无') + '\n';
    txt += '流程：\n' + (p.steps.map(s => s.no + '. ' + (s.done ? '[x] ' : '[ ] ') + s.text).join('\n') || '  无') + '\n';
    wx.setClipboardData({ data: txt, success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'success' }) });
  },

  // ===== 提醒 =====
  gotoDate(e) { this.st.selectedDate = e.currentTarget.dataset.date; this.setData({ tab: 'todo' }); this.commit(); }
});
