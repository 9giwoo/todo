// 내 할 일 — 업무/개인 할 일 + 구글 캘린더 보기
import * as D from './dates.js';
import {
  REPEAT_TYPES, isRepeating, normalizeRule, ruleText, planGeneration, projectedDates,
  TEMPLATE_FIELDS, templateFromTask, taskFromTemplate,
} from './recur.js';
import { createLocalStore } from './store-local.js';
import { createGcal, eventsOnDay } from './gcal.js';

const CFG = window.APP_CONFIG || {};
const DEMO = !CFG.FIREBASE || !CFG.FIREBASE.apiKey;
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

const PRIOS = [['high', '높음'], ['mid', '보통'], ['low', '낮음']];
const STATUSES = [['todo', '할 일'], ['doing', '진행 중'], ['waiting', '대기'], ['done', '완료']];
const PRIO_ORDER = { high: 0, mid: 1, low: 2 };
const MODE = {
  work: { title: '내 업무', noun: '업무', cal: '회사 캘린더', calFull: '업무용 구글 캘린더', placeholder: '업무 내용을 한 줄로 적기' },
  personal: { title: '내 생활', noun: '할 일', cal: '개인 캘린더', calFull: '개인용 구글 캘린더', placeholder: '할 일을 한 줄로 적기' },
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

let store;
let gcal;

const state = {
  user: undefined,
  tasks: [],
  series: [],
  settings: {},
  loaded: { tasks: false, series: false },
  mode: LS.get('mode', 'work'),
  view: LS.get('view', 'list'),
  calView: LS.get('calView', 'week'),
  cursor: D.today(),
  selDay: D.today(),
  selected: { work: null, personal: null },
  showDone: false,
  showDayDone: false,
  showTasks: true,
  showEvents: true,
  events: { work: [], personal: [] },
  evInfo: { work: {}, personal: {} },
  checks: new Map(), // 구글 캘린더 일정 완료 체크
  overlay: null, // { type: 'detail', id } | { type: 'settings' }
  confirmDelete: null,
};

/* ---------------- 공통 ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }, 2600);
}
const fail = (e) => { console.error(e); toast(errText(e)); };
function errText(e) {
  const c = e && (e.code || '');
  if (c.includes('permission-denied')) return '이 계정은 사용할 수 없어요. 보안 규칙의 이메일을 확인해 주세요.';
  if (c.includes('popup-closed')) return '로그인 창이 닫혔어요';
  if (c.includes('unauthorized-domain')) return '이 주소가 Firebase 승인된 도메인에 없어요 (README 5단계)';
  return (e && e.message) || '문제가 생겼어요';
}

const modeTasks = () => state.tasks.filter((t) => (t.space || 'work') === state.mode);
const byId = (id) => state.tasks.find((t) => t.id === id);
const seriesById = (id) => state.series.find((s) => s.id === id);
const listOf = (key) => (Array.isArray(state.settings[key]) ? state.settings[key] : []);
const isOverdue = (t, td = D.today()) => !t.done && t.doDate < td;
// 할 시간 · 오전/오후: 시간이 있으면 시간 기준, 없으면 오전/오후 표시 기준
const SEC_ORDER = { any: 0, am: 1, pm: 2 };
const slotOf = (x) => (x.doTime ? (x.doTime < '12:00' ? 'am' : 'pm') : (x.slot || ''));
const taskSec = (x) => slotOf(x) || 'any';
const taskKey = (x) => x.doTime || (x.slot === 'am' ? '11:59' : x.slot === 'pm' ? '23:58' : '');
const timeLabel = (x) => x.doTime || (x.slot === 'am' ? '오전' : x.slot === 'pm' ? '오후' : '');
const byTime = (a, b) => (SEC_ORDER[taskSec(a)] - SEC_ORDER[taskSec(b)]) || taskKey(a).localeCompare(taskKey(b));

/* ---------------- 시작 ---------------- */
async function init() {
  document.title = CFG.APP_NAME || '내 할 일';
  gcal = createGcal({ clientId: CFG.GOOGLE_CLIENT_ID, demo: DEMO });
  if (DEMO) store = createLocalStore();
  else {
    try {
      const m = await import('./store-firebase.js');
      store = m.createFirebaseStore(CFG.FIREBASE);
    } catch (e) {
      console.error(e);
      $('#main').innerHTML = `<div class="boot">Firebase를 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요.</div>`;
      return;
    }
  }
  store.init((user) => {
    state.user = user;
    if (user) {
      store.watch({
        onTasks: (list) => { state.tasks = list; state.loaded.tasks = true; afterData(); },
        onSeries: (list) => { state.series = list; state.loaded.series = true; afterData(); scheduleGenerate(); },
        onSettings: (s) => { state.settings = s || {}; render(); },
        onChecks: (list) => { state.checks = new Map(list.map((c) => [c.id, c])); if (state.view === 'calendar') renderMain(); },
        onError: fail,
      }, D.addDays(D.today(), -45));
    }
    render();
    if (user) loadEvents();
  });
  window.addEventListener('online', () => { updateNet(); scheduleGenerate(); loadEvents(); });
  window.addEventListener('offline', updateNet);
  updateNet();
  // 날짜가 바뀌면(자정 넘김) 반복 회차 생성과 화면 갱신
  let lastDay = D.today();
  setInterval(() => { if (D.today() !== lastDay) { lastDay = D.today(); scheduleGenerate(); render(); } }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.user) { scheduleGenerate(); loadEvents(); } });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function afterData() {
  if (!state.loaded.tasks) return;
  render();
}

function updateNet() { $('#net').hidden = navigator.onLine; }

/* ---------------- 반복 회차 자동 생성 ---------------- */
let genTimer; let genBusy = false;
function scheduleGenerate() { clearTimeout(genTimer); genTimer = setTimeout(generate, 400); }
async function generate() {
  if (genBusy || !state.loaded.series || !state.user) return;
  genBusy = true;
  const td = D.today();
  for (const s of state.series) {
    const plan = planGeneration(s, td);
    if (!plan.dates.length) continue;
    try {
      for (const d of plan.dates) await store.createTaskIfAbsent(`${s.id}_${d}`, taskFromTemplate(s, d));
      await store.updateSeries(s.id, { lastDate: plan.lastDate });
    } catch (e) { console.warn('반복 회차 생성 보류(오프라인일 수 있음)', e); }
  }
  genBusy = false;
}

/* ---------------- 저장 ---------------- */
function applyLocal(id, patch) {
  const t = byId(id);
  if (t) Object.assign(t, patch);
  return t;
}

function saveTask(id, patch, { quiet } = {}) {
  const t = applyLocal(id, patch);
  if (!quiet) renderMain();
  Promise.resolve(store.updateTask(id, patch)).catch(fail);
  // 반복 업무면 다음 회차부터도 같은 내용이 적용되도록 템플릿 갱신
  if (t && t.seriesId && Object.keys(patch).some((k) => TEMPLATE_FIELDS.includes(k) || k === 'subtasks' || k === 'dueDate')) {
    const s = seriesById(t.seriesId);
    if (s) { s.template = templateFromTask(t); Promise.resolve(store.updateSeries(s.id, { template: s.template })).catch(fail); }
    // 이미 만들어진 다음 회차(아직 안 한 것)에도 같은 내용 반영
    const fp = {};
    Object.keys(patch).forEach((k) => { if (TEMPLATE_FIELDS.includes(k)) fp[k] = patch[k]; });
    if (patch.subtasks) fp.subtasks = patch.subtasks.map((x) => ({ text: x.text, done: false }));
    if (Object.keys(fp).length) {
      state.tasks.filter((x) => x.seriesId === t.seriesId && x.id !== t.id && !x.done && x.doDate > t.doDate)
        .forEach((x) => { Object.assign(x, fp); Promise.resolve(store.updateTask(x.id, fp)).catch(fail); });
    }
  }
}

function rememberName(key, name) {
  const v = (name || '').trim();
  if (!v || listOf(key).includes(v)) return;
  const next = [...listOf(key), v];
  state.settings[key] = next;
  Promise.resolve(store.saveSettings({ [key]: next })).catch(fail);
}

async function addTask(data) {
  if (!data.title) { toast(`${MODE[state.mode].noun} 내용을 적어 주세요`); return null; }
  if (!data.doDate) { toast('할 날짜는 꼭 정해 주세요'); return null; }
  const t = {
    space: state.mode, title: data.title, brand: data.brand || '', media: data.media || '', category: data.category || '',
    doDate: data.doDate, doTime: data.doTime || '', slot: data.doTime ? (data.doTime < '12:00' ? 'am' : 'pm') : (data.slot || ''),
    dueDate: '', dueTime: '', priority: 'mid', status: 'todo', done: false,
    memo: '', subtasks: [], repeat: { type: 'none', days: [] }, seriesId: null,
  };
  if (state.mode === 'work') { rememberName('workBrands', t.brand); rememberName('workMedia', t.media); } else rememberName('personalCategories', t.category);
  try { return await store.addTask(t); } catch (e) { fail(e); return null; }
}

function toggleDone(id) {
  const t = byId(id); if (!t) return;
  const done = !t.done;
  saveTask(id, { done, status: done ? 'done' : (t.status === 'done' ? 'todo' : t.status) });
}

function deleteFuture(seriesId, exceptId) {
  const td = D.today();
  state.tasks.filter((x) => x.seriesId === seriesId && !x.done && x.doDate > td && x.id !== exceptId)
    .forEach((x) => { Promise.resolve(store.deleteTask(x.id)).catch(fail); });
}

async function setRepeat(id, rule) {
  const t = byId(id); if (!t) return;
  const td = D.today();
  try {
    if (!isRepeating(rule)) {
      if (t.seriesId) { await store.updateSeries(t.seriesId, { active: false }); deleteFuture(t.seriesId, t.id); }
      saveTask(id, { repeat: { type: 'none', days: [] }, seriesId: null });
      return;
    }
    const r = normalizeRule(rule, t.doDate);
    const last = t.doDate >= td ? t.doDate : D.addDays(td, -1);
    if (!t.seriesId) {
      const sid = await store.addSeries({ space: t.space, rule: r, anchorDate: t.doDate, lastDate: last, active: true, template: templateFromTask(t) });
      saveTask(id, { repeat: r, seriesId: sid });
    } else {
      deleteFuture(t.seriesId, t.id);
      await store.updateSeries(t.seriesId, { rule: r, anchorDate: t.doDate, lastDate: last, active: true, template: templateFromTask(t) });
      saveTask(id, { repeat: r });
    }
    scheduleGenerate();
  } catch (e) { fail(e); }
}

/* ---------------- 렌더 ---------------- */
function render() {
  const signedIn = !!state.user;
  document.body.className = `mode-${state.mode}`;
  $('meta[name="theme-color"]').setAttribute('content', state.mode === 'work' ? '#3451d1' : '#0e7c66');
  $('#top').hidden = !signedIn;
  if (state.user === undefined) return;
  if (!signedIn) { $('#main').innerHTML = loginHTML(); return; }
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  $('#title').textContent = MODE[state.mode].title;
  const left = modeTasks().filter((t) => !t.done).length;
  $('#subtitle').textContent = `${D.fmtLong(D.today())} · 남은 ${MODE[state.mode].noun} ${left}개`;
  renderMain();
  renderOverlay();
}

function renderMain() {
  if (!state.user) return;
  const main = $('#main');
  if (!state.loaded.tasks) { main.innerHTML = '<div class="boot">불러오는 중…</div>'; return; }
  const keep = captureFocus(main);
  main.innerHTML = state.view === 'calendar' ? calendarHTML() : listHTML();
  restoreFocus(main, keep);
  const left = modeTasks().filter((t) => !t.done).length;
  $('#subtitle').textContent = `${D.fmtLong(D.today())} · 남은 ${MODE[state.mode].noun} ${left}개`;
  if (state.overlay && state.overlay.type === 'detail') renderOverlay();
}

// 입력 중이던 칸이 다시 그려져도 내용과 커서가 유지되도록
function captureFocus(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a) || !a.id) return null;
  return { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd };
}
function restoreFocus(root, k) {
  if (!k) return;
  const el = root.querySelector('#' + k.id);
  if (!el) return;
  el.value = k.value; el.focus();
  try { el.setSelectionRange(k.start, k.end); } catch { /* 날짜 칸 등 */ }
}

function loginHTML() {
  return `<section class="login card">
    <img src="icon-192.png" alt="" width="72" height="72">
    <h2>${esc(CFG.APP_NAME || '내 할 일')}</h2>
    <p>업무와 개인 할 일을 나눠 기록하고, 구글 캘린더와 함께 봐요.<br>웹과 폰에서 같은 내용이 자동으로 맞춰져요.</p>
    <button class="btn primary big" data-act="login">Google 계정으로 로그인</button>
  </section>`;
}

/* ---------- 목록 ---------- */
function chipsHTML(t) {
  const c = [];
  if (t.space === 'personal') { if (t.category) c.push(`<span class="chip cat">${esc(t.category)}</span>`); } else {
    if (t.brand) c.push(`<span class="chip brand">${esc(t.brand)}</span>`);
    if (t.media) c.push(`<span class="chip media">${esc(t.media)}</span>`);
  }
  return c.join('');
}

function rowHTML(t, { showDate = true } = {}) {
  const td = D.today();
  const late = isOverdue(t, td);
  const high = t.priority === 'high' && !t.done;
  const sel = state.selected[state.mode] === t.id && !isMobile() && state.view === 'list';
  const subs = t.subtasks || [];
  const subDone = subs.filter((s) => s.done).length;
  let dateTxt = D.fmtRelative(t.doDate, td);
  if (late) dateTxt = `${D.fmtShort(t.doDate)} · ${D.diffDays(t.doDate, td)}일 지남`;
  const doing = t.status === 'doing' && !t.done;
  const cls = ['row', high ? 'high' : '', late ? 'late' : '', doing ? 'doing' : '', t.done ? 'done' : '', sel ? 'sel' : ''].join(' ');
  return `<div class="${cls}">
    <input type="checkbox" class="chk" data-act="toggle" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="${esc(t.title)} 완료">
    <button class="row-main" data-act="open" data-id="${t.id}">
      ${chipsHTML(t)}
      ${timeLabel(t) ? `<span class="tchip ${slotOf(t)}">${esc(timeLabel(t))}</span>` : ''}
      ${doing ? '<span class="badge-doing"><i></i>진행 중</span>' : ''}
      <span class="row-title">${esc(t.title)}</span>
      ${high ? '<span class="badge-high">높음</span>' : ''}
      ${isRepeating(t.repeat) ? `<span class="meta rep" title="반복">↻ ${esc(ruleText(t.repeat, (seriesById(t.seriesId) || {}).anchorDate || t.doDate))}</span>` : ''}
      ${t.result ? '<span class="meta res" title="성과 기록 있음">★ 성과</span>' : ''}
      ${subs.length ? `<span class="meta">☑ ${subDone}/${subs.length}</span>` : ''}
      ${showDate ? `<span class="row-date ${late ? 'late' : t.doDate === td ? 'today' : ''}">${esc(dateTxt)}</span>` : ''}
    </button>
  </div>`;
}

function quickFormHTML(id, dateValue, { compact } = {}) {
  const work = state.mode === 'work';
  const f = (name, label, list, ph) => `<label class="f f-${name}"><span>${label}</span><input id="${id}-${name}" name="${name}" ${list ? `list="dl-${list}"` : ''} placeholder="${ph}" autocomplete="off"></label>`;
  return `<form class="quick ${compact ? 'compact' : ''}" data-form="quick" id="${id}">
    ${work ? f('brand', '브랜드', 'brand', '없음') + f('media', '매체', 'media', '없음') : f('category', '분류', 'cat', '없음')}
    <label class="f f-title"><span>${work ? '업무 내용' : '할 일'}</span><input id="${id}-title" name="title" placeholder="${MODE[state.mode].placeholder}" autocomplete="off"></label>
    <label class="f f-date"><span>할 날짜 <b class="req">*</b></span><input id="${id}-date" type="date" name="doDate" value="${dateValue}" required></label>
    <label class="f f-time"><span>할 시간</span><input id="${id}-time" type="time" name="doTime"></label>
    <div class="f f-slot"><span>언제</span><input type="hidden" name="slot" value="">
      <div class="seg slot-seg"><button type="button" data-act="qslot" data-v="am" aria-pressed="false">오전</button><button type="button" data-act="qslot" data-v="pm" aria-pressed="false">오후</button></div>
    </div>
    <button class="btn primary" type="submit">추가</button>
  </form>`;
}

function datalistsHTML() {
  const dl = (id, arr) => `<datalist id="dl-${id}">${arr.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  return dl('brand', listOf('workBrands')) + dl('media', listOf('workMedia')) + dl('cat', listOf('personalCategories'));
}

let quickDate = D.today();
function listHTML() {
  const td = D.today();
  const all = modeTasks();
  const late = all.filter((t) => isOverdue(t, td)).sort((a, b) => a.doDate.localeCompare(b.doDate) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]));
  const next = all.filter((t) => !t.done && t.doDate >= td)
    .sort((a, b) => a.doDate.localeCompare(b.doDate) || byTime(a, b) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (a.createdAt - b.createdAt));
  const done = all.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 50);
  const noun = MODE[state.mode].noun;
  const sel = byId(state.selected[state.mode]);
  const selOk = sel && sel.space === state.mode ? sel : null;
  return `<div class="layout">
    <section class="card list-card">
      ${quickFormHTML('q', quickDate)}
      <div class="rows">
        ${late.length ? `<div class="group-h late">밀린 ${noun} ${late.length}</div>${late.map((t) => rowHTML(t)).join('')}` : ''}
        <div class="group-h">예정된 ${noun} ${next.length}</div>
        ${next.length ? next.map((t) => rowHTML(t)).join('') : `<div class="empty">예정된 ${noun}이 없어요. 위에서 추가해 보세요.</div>`}
        <button class="group-h toggle" data-act="toggle-done" aria-expanded="${state.showDone}">완료 ${done.length}${done.length >= 50 ? '+' : ''} ${state.showDone ? '▴' : '▾'}</button>
        ${state.showDone ? done.map((t) => rowHTML(t)).join('') : ''}
      </div>
    </section>
    <aside class="card detail-side" aria-label="상세">
      ${selOk ? detailHTML(selOk) : `<div class="empty side-empty">${noun}을 누르면 여기에서 자세한 내용을 적을 수 있어요.</div>`}
    </aside>
    ${datalistsHTML()}
  </div>`;
}

/* ---------- 상세 ---------- */
function detailHTML(t) {
  const td = D.today();
  const work = t.space !== 'personal';
  const rule = normalizeRule(t.repeat, t.doDate);
  const s = seriesById(t.seriesId);
  const anchor = (s && s.anchorDate) || t.doDate;
  const subs = t.subtasks || [];
  const late = isOverdue(t, td);
  const del = state.confirmDelete === t.id;
  return `<div class="detail" data-id="${t.id}">
    <div class="d-head">
      <button class="icon-btn d-close" data-act="close" aria-label="닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <span class="muted small">${navigator.onLine ? '자동 저장 · 다른 기기와 동기화' : '오프라인 · 연결되면 동기화'}</span>
    </div>
    <div class="d-cats">
      ${work ? `
      <label class="f"><span>브랜드</span><input id="d-brand" data-f="brand" list="dl-brand" value="${esc(t.brand)}" placeholder="없음" autocomplete="off"></label>
      <label class="f"><span>매체</span><input id="d-media" data-f="media" list="dl-media" value="${esc(t.media)}" placeholder="없음" autocomplete="off"></label>` : `
      <label class="f"><span>분류</span><input id="d-category" data-f="category" list="dl-cat" value="${esc(t.category)}" placeholder="없음" autocomplete="off"></label>`}
    </div>
    <label class="f"><span>${work ? '업무 내용' : '할 일'}</span><textarea id="d-title" data-f="title" rows="2" class="d-title">${esc(t.title)}</textarea></label>
    <div class="d-dates">
      <label class="f"><span>할 날짜 <b class="req">*</b></span><input id="d-doDate" type="date" data-f="doDate" value="${t.doDate}" required></label>
      <label class="f"><span>할 시간</span><input id="d-doTime" type="time" data-f="doTime" value="${t.doTime || ''}"></label>
      <label class="f"><span>마감일</span><input id="d-dueDate" type="date" data-f="dueDate" value="${t.dueDate || ''}"></label>
      <label class="f"><span>마감 시간</span><input id="d-dueTime" type="time" data-f="dueTime" value="${t.dueTime || ''}"></label>
    </div>
    <div class="f"><span>언제 끝낼 일인가요</span>
      <div class="pills">${[['am', '오전'], ['pm', '오후']].map(([v, l]) => `<button class="pill slot-${v} ${slotOf(t) === v ? 'on' : ''}" data-act="slot" data-v="${v}" aria-pressed="${slotOf(t) === v}">${l}</button>`).join('')}</div>
    </div>
    ${late ? `<p class="warn">할 날짜가 ${D.diffDays(t.doDate, td)}일 지났어요. 완료하거나 날짜를 옮겨 주세요.</p>` : ''}
    <div class="f"><span>반복</span>
      <div class="pills">${REPEAT_TYPES.map(([v, l]) => `<button class="pill ${rule.type === v ? 'on' : ''}" data-act="repeat" data-v="${v}" aria-pressed="${rule.type === v}">${l}</button>`).join('')}</div>
      ${rule.type === 'weekly' ? `<div class="wdays">${D.WD.map((w, i) => `<button class="wdb ${rule.days.includes(i) ? 'on' : ''}" data-act="wday" data-v="${i}" aria-pressed="${rule.days.includes(i)}" aria-label="${w}요일">${w}</button>`).join('')}</div>` : ''}
      ${isRepeating(rule) ? `<p class="hint">${esc(ruleText(rule, anchor))} 반복 · 다음 회차는 자동으로 생겨요. 지금 고친 내용은 다음 회차에도 적용돼요.</p>` : ''}
    </div>
    <div class="f"><span>우선순위</span>
      <div class="pills">${PRIOS.map(([v, l]) => `<button class="pill prio-${v} ${t.priority === v ? 'on' : ''}" data-act="prio" data-v="${v}" aria-pressed="${t.priority === v}">${l}</button>`).join('')}</div>
    </div>
    <div class="f"><span>진행 상태</span>
      <div class="seg">${STATUSES.map(([v, l]) => `<button class="${t.status === v ? 'on' : ''}" data-act="status" data-v="${v}" aria-pressed="${t.status === v}">${l}</button>`).join('')}</div>
    </div>
    <div class="f"><span>하위 할 일 ${subs.length ? `(${subs.filter((x) => x.done).length}/${subs.length})` : ''}</span>
      <div class="subs">
        ${subs.map((x, i) => `<div class="sub ${x.done ? 'done' : ''}">
          <input type="checkbox" class="chk" data-act="sub-toggle" data-i="${i}" ${x.done ? 'checked' : ''} aria-label="${esc(x.text)} 완료">
          <input id="d-sub-${i}" class="sub-text" data-f="sub" data-i="${i}" value="${esc(x.text)}" aria-label="하위 할 일">
          <button class="icon-btn small" data-act="sub-del" data-i="${i}" aria-label="삭제"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`).join('')}
        <form class="sub-add" data-form="sub"><input id="d-subnew" name="text" placeholder="+ 하위 할 일 추가" autocomplete="off"></form>
      </div>
    </div>
    <label class="f"><span>메모</span><textarea id="d-memo" data-f="memo" rows="4">${esc(t.memo)}</textarea></label>
    ${work ? `<label class="f f-result"><span>성과 · 결과</span><textarea id="d-result" data-f="result" rows="3" placeholder="예: CTR 1.2% → 2.1% 개선, CPA 30% 절감, 월 광고비 5천만 원 운영">${esc(t.result || '')}</textarea></label>` : ''}
    <div class="d-foot">
      <button class="btn danger ${del ? 'confirm' : ''}" data-act="delete">${del ? '한 번 더 누르면 삭제' : '삭제'}</button>
      ${t.seriesId ? '<button class="btn ghost" data-act="stop-repeat">반복 그만하기</button>' : ''}
    </div>
  </div>`;
}

function renderDetailInto(el, t) {
  if (!el) return;
  const a = document.activeElement;
  if (a && el.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'date', 'time'].includes(a.type)))) return; // 입력 중이면 건드리지 않음
  el.innerHTML = t ? detailHTML(t) : '';
}

/* ---------- 캘린더 ---------- */
function calRange() {
  if (state.calView === 'week') { const s = D.startOfWeek(state.cursor); return [s, D.addDays(s, 7)]; }
  const g = D.monthGrid(state.cursor); return [g[0], D.addDays(g[41], 1)];
}

async function loadEvents() {
  if (!state.user) return;
  const mode = state.mode;
  const [from, to] = calRange();
  store.setSince(from < D.addDays(D.today(), -45) ? from : D.addDays(D.today(), -45));
  const r = await gcal.events(mode, from, to);
  state.events[mode] = r.events || [];
  state.evInfo[mode] = { needAuth: !!r.needAuth, none: !!r.none, error: r.error || '' };
  if (state.view === 'calendar' && state.mode === mode) renderMain();
}

function dayItems(day) {
  const tasks = state.showTasks ? modeTasks().filter((t) => t.doDate === day) : [];
  tasks.sort((a, b) => byTime(a, b) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (a.createdAt - b.createdAt));
  const events = state.showEvents ? eventsOnDay(state.events[state.mode], day) : [];
  const proj = [];
  if (state.showTasks) {
    state.series.filter((s) => s.space === state.mode).forEach((s) => {
      if (projectedDates(s, day, day).length) proj.push(s);
    });
  }
  return { tasks, events, proj };
}

// 일정·할 일·반복 예정을 [시간 없음] → [오전] → [오후] 순서, 그 안에서 시간순으로 쌓기
function dayBlocks(day) {
  const { tasks, events, proj } = dayItems(day);
  const blocks = [
    ...events.map((e) => ({ kind: 'event', e, sec: e.allDay ? 'any' : (e.time < '12:00' ? 'am' : 'pm'), key: e.allDay ? '' : e.time, rank: 0 })),
    ...tasks.map((t) => ({ kind: 'task', t, sec: taskSec(t), key: taskKey(t), rank: 1 })),
    ...proj.map((s) => { const tp = s.template || {}; return { kind: 'proj', s, sec: taskSec(tp), key: taskKey(tp), rank: 2 }; }),
  ];
  blocks.sort((a, b) => (SEC_ORDER[a.sec] - SEC_ORDER[b.sec]) || a.key.localeCompare(b.key) || (a.rank - b.rank));
  return { blocks, tasks, events, proj };
}
const SEC_LABEL = { am: '오전', pm: '오후' };
function stackHTML(blocks, render) {
  let prev = null; const out = [];
  blocks.forEach((b) => {
    if (b.sec !== prev && b.sec !== 'any') out.push(`<div class="sec-h sec-${b.sec}">${SEC_LABEL[b.sec]}</div>`);
    prev = b.sec; out.push(render(b));
  });
  return out.join('');
}

function taskChip(t, day) {
  const late = isOverdue(t);
  const high = t.priority === 'high' && !t.done;
  const top = [timeLabel(t), isRepeating(t.repeat) ? '↻' : '', t.space === 'personal' ? t.category : [t.brand, t.media].filter(Boolean).join(' · '), late ? '밀림' : '', high ? '높음' : ''].filter(Boolean).join(' · ');
  const due = t.dueDate && t.dueDate !== day ? `마감 ${D.md(t.dueDate)}${t.dueTime ? ' ' + t.dueTime : ''}` : (t.dueTime ? `마감 ${t.dueTime}` : '');
  const doing = t.status === 'doing' && !t.done;
  return `<button class="ci task ${late ? 'late' : ''} ${high ? 'high' : ''} ${doing ? 'doing' : ''} ${t.done ? 'done' : ''}" data-act="open" data-id="${t.id}">
    ${doing ? '<span class="ci-doing"><i></i>진행 중</span>' : ''}
    ${top ? `<span class="ci-top">${esc(top)}</span>` : ''}
    <span class="ci-title">${esc(t.title)}</span>
    ${due ? `<span class="ci-sub">${esc(due)}</span>` : ''}
  </button>`;
}
// 구글 캘린더 일정 완료 체크: 캘린더는 그대로 두고 이 앱에만 기록
const evKey = (mode, e) => `${mode}__${e.id}`.replace(/[^A-Za-z0-9_@.\-]/g, '_').slice(0, 700);
const evDone = (e) => state.checks.has(evKey(state.mode, e));
const eventChip = (e) => { const done = evDone(e); return `<div class="ci event ${done ? 'done' : ''}" title="${esc(MODE[state.mode].cal)} (보기 전용)"><span class="ci-top"><button class="ev-chk ${done ? 'on' : ''}" data-act="ev-toggle" data-ev="${esc(e.id)}" aria-pressed="${done}" aria-label="${esc(e.title)} 완료 표시">${done ? '✓' : ''}</button>${esc(e.time)}</span><span class="ci-title">${esc(e.title)}</span></div>`; };
const projChip = (s) => `<div class="ci proj" title="앞으로 생길 반복 회차"><span class="ci-top">${esc([timeLabel(s.template || {}), '↻ 예정'].filter(Boolean).join(' · '))}</span><span class="ci-title">${esc((s.template || {}).title || '')}</span></div>`;

function calendarHTML() {
  const td = D.today();
  const info = state.evInfo[state.mode] || {};
  const st = gcal.status(state.mode);
  const calName = MODE[state.mode].cal;
  let calCtl = '';
  if (st === 'none') calCtl = `<button class="btn small ghost" data-act="gcal-connect">${calName} 연결</button>`;
  else if (info.needAuth || st === 'expired') calCtl = `<button class="btn small ghost" data-act="gcal-connect" title="${esc(gcal.email(state.mode))}">↻ ${calName} 새로고침</button>`;
  const body = state.calView === 'week' ? weekHTML(td) : monthHTML(td);
  const sel = state.selDay;
  const { blocks, tasks: dTasks, events: dEvents } = dayBlocks(sel);
  const isDoneB = (b) => (b.kind === 'task' ? !!b.t.done : b.kind === 'event' ? evDone(b.e) : false);
  const openB = blocks.filter((b) => !isDoneB(b));
  const doneB = blocks.filter(isDoneB);
  const tDone = dTasks.filter((t) => t.done).length;
  const eDone = dEvents.filter((e) => evDone(e)).length;
  const total = dTasks.length + dEvents.length;
  const pct = total ? Math.round(((tDone + eDone) / total) * 100) : 0;
  const noun = MODE[state.mode].noun;
  const dpItem = (b) => {
    if (b.kind === 'event') {
      const e = b.e; const done = evDone(e);
      return `<div class="dpi ev ${done ? 'done' : ''}">
        <div class="dpi-time ${e.allDay ? 'allday' : ''}">${esc(e.time)}</div>
        <input type="checkbox" class="chk" data-act="ev-toggle" data-ev="${esc(e.id)}" ${done ? 'checked' : ''} aria-label="${esc(e.title)} 완료 표시">
        <div class="dpi-body"><span class="dpi-title">${esc(e.title)}</span><span class="dpi-meta"><span class="dpi-tag ev">일정</span>${esc(calName)} · 보기 전용</span></div>
      </div>`;
    }
    if (b.kind === 'proj') {
      const tp = b.s.template || {};
      const cat = state.mode === 'personal' ? tp.category : [tp.brand, tp.media].filter(Boolean).join(' · ');
      return `<div class="dpi proj">
        <div class="dpi-time ${slotOf(tp)}">${esc(timeLabel(tp) || '—')}</div>
        <span class="dpi-ico">↻</span>
        <div class="dpi-body"><span class="dpi-title">${esc(tp.title || '')}</span><span class="dpi-meta">${cat ? esc(cat) + ' · ' : ''}반복 예정</span></div>
      </div>`;
    }
    const t = b.t;
    const late = isOverdue(t, td);
    const high = t.priority === 'high' && !t.done;
    const doing = t.status === 'doing' && !t.done;
    const subs = t.subtasks || [];
    const cat = t.space === 'personal' ? t.category : [t.brand, t.media].filter(Boolean).join(' · ');
    const due = t.dueDate && t.dueDate !== sel ? `마감 ${D.md(t.dueDate)}${t.dueTime ? ' ' + t.dueTime : ''}` : (t.dueTime ? `마감 ${t.dueTime}` : '');
    const meta = [
      cat ? `<span class="dpi-cat">${esc(cat)}</span>` : '',
      isRepeating(t.repeat) ? '<span>↻ 반복</span>' : '',
      due ? `<span class="${t.dueDate && t.dueDate < td && !t.done ? 'warn' : ''}">${esc(due)}</span>` : '',
      subs.length ? `<span>☑ ${subs.filter((x) => x.done).length}/${subs.length}</span>` : '',
      t.result ? '<span>★ 성과</span>' : '',
    ].filter(Boolean).join('<i class="dot">·</i>');
    return `<div class="dpi task ${t.done ? 'done' : ''} ${high ? 'high' : ''} ${late ? 'late' : ''} ${doing ? 'doing' : ''}">
      <div class="dpi-time ${slotOf(t)}">${esc(timeLabel(t) || '—')}</div>
      <input type="checkbox" class="chk" data-act="toggle" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="${esc(t.title)} 완료">
      <button class="dpi-body" data-act="open" data-id="${t.id}">
        <span class="dpi-title">${doing ? '<span class="dpi-tag doing"><i></i>진행 중</span>' : ''}${high ? '<span class="dpi-tag high">높음</span>' : ''}${late ? '<span class="dpi-tag late">밀림</span>' : ''}${esc(t.title)}</span>
        ${meta ? `<span class="dpi-meta">${meta}</span>` : ''}
      </button>
    </div>`;
  };
  const dpStack = (list) => {
    const out = []; let prev = null;
    list.forEach((b) => {
      if (b.sec !== prev) {
        const n = list.filter((x) => x.sec === b.sec).length;
        out.push(`<div class="dp-sec sec-${b.sec}"><span>${b.sec === 'any' ? '시간 미정' : SEC_LABEL[b.sec]}</span><em>${n}</em></div>`);
      }
      prev = b.sec; out.push(dpItem(b));
    });
    return out.join('');
  };
  const dpSummary = total ? `<div class="dp-sum">
      <div class="dp-stats">
        <span><b>${dTasks.length - tDone}</b> 남은 ${noun}</span>
        ${dEvents.length ? `<span><b>${dEvents.length - eDone}</b> 남은 일정</span>` : ''}
        <span class="ok"><b>${tDone + eDone}</b> 완료</span>
      </div>
      <div class="dp-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    </div>` : '';
  const dpList = !blocks.length
    ? `<div class="empty">이 날 할 ${noun}과 일정이 없어요.</div>`
    : `${openB.length ? dpStack(openB) : '<div class="dp-clear">🎉 이 날 할 일을 모두 끝냈어요</div>'}
       ${doneB.length ? `<button class="dp-done-toggle" data-act="dp-done" aria-expanded="${state.showDayDone}">완료 ${doneB.length} <span>${state.showDayDone ? '접기 ▴' : '펼치기 ▾'}</span></button>
         ${state.showDayDone ? `<div class="dp-done-list">${doneB.map(dpItem).join('')}</div>` : ''}` : ''}`;
  return `<div class="layout cal-layout">
    <section class="card cal-card">
      <div class="cal-bar">
        <div class="cal-nav">
          <button class="icon-btn" data-act="cal-prev" aria-label="이전"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
          <h2>${state.calView === 'week' ? D.weekLabel(D.startOfWeek(state.cursor)) : D.fmtYearMonth(state.cursor)}</h2>
          <button class="icon-btn" data-act="cal-next" aria-label="다음"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
          <button class="btn small ghost" data-act="cal-today">오늘</button>
        </div>
        <div class="seg small-seg">
          <button class="${state.calView === 'week' ? 'on' : ''}" data-act="cal-view" data-v="week" aria-pressed="${state.calView === 'week'}">주</button>
          <button class="${state.calView === 'month' ? 'on' : ''}" data-act="cal-view" data-v="month" aria-pressed="${state.calView === 'month'}">월</button>
        </div>
      </div>
      <div class="cal-legend">
        <label><input type="checkbox" class="chk" data-act="show-tasks" ${state.showTasks ? 'checked' : ''}><i class="sw task"></i>${state.mode === 'work' ? '내 업무' : '내 할 일'}</label>
        <label><input type="checkbox" class="chk" data-act="show-events" ${state.showEvents ? 'checked' : ''}><i class="sw event"></i>${calName} <span class="muted">(보기 전용)</span></label>
        ${calCtl}
        ${info.error ? `<span class="muted small">캘린더 오류: ${esc(info.error)}</span>` : ''}
      </div>
      ${body}
    </section>
    <aside class="card day-panel" aria-label="선택한 날짜">
      <h3>${D.fmtLong(sel)}${sel === td ? ' <span class="dp-today">오늘</span>' : ''}</h3>
      ${dpSummary}
      <div class="dp-group">
        ${dpList}
        ${st === 'none' ? `<div class="empty small">${calName}이 연결되지 않았어요.</div>` : ''}
      </div>
      <div class="dp-add">
        <div class="group-h">${MODE[state.mode].noun} 추가</div>
        ${quickFormHTML('dq', sel, { compact: true })}
      </div>
    </aside>
    ${datalistsHTML()}
  </div>`;
}

function weekHTML(td) {
  const s = D.startOfWeek(state.cursor);
  const cols = Array.from({ length: 7 }, (_, i) => D.addDays(s, i)).map((day, i) => {
    const { blocks, tasks } = dayBlocks(day);
    const cls = ['wk-col', day === td ? 'today' : '', day === state.selDay ? 'sel' : '', i === 5 ? 'sat' : '', i === 6 ? 'sun' : ''].join(' ');
    return `<div class="${cls}">
      <button class="wk-head" data-act="pick-day" data-day="${day}" aria-label="${D.fmtLong(day)}">
        <span class="wd">${D.WD[i]}</span><span class="dn">${D.parse(day).getDate()}</span>
        <span class="cnt">${tasks.filter((t) => !t.done).length ? tasks.filter((t) => !t.done).length + '건' : ''}</span>
      </button>
      <div class="wk-items">${stackHTML(blocks, (b) => (b.kind === 'event' ? eventChip(b.e) : b.kind === 'task' ? taskChip(b.t, day) : projChip(b.s)))}</div>
      <button class="wk-add" data-act="pick-day" data-day="${day}" aria-label="${D.fmtLong(day)}에 추가">+</button>
    </div>`;
  }).join('');
  return `<div class="week">${cols}</div>`;
}

function monthHTML(td) {
  const grid = D.monthGrid(state.cursor);
  const m = D.parse(state.cursor).getMonth();
  const head = D.WD.map((w, i) => `<span class="${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</span>`).join('');
  const cells = grid.map((day, i) => {
    const { blocks } = dayBlocks(day);
    const wd = i % 7;
    const items = blocks.map((b) => {
      if (b.kind === 'event') return { c: 'event' + (evDone(b.e) ? ' done' : ''), t: `${b.e.allDay ? '' : b.e.time + ' '}${b.e.title}` };
      if (b.kind === 'task') { const t = b.t; return { c: `task ${isOverdue(t) ? 'late' : ''} ${t.priority === 'high' && !t.done ? 'high' : ''} ${t.done ? 'done' : ''}`, t: (timeLabel(t) ? timeLabel(t) + ' ' : '') + (isRepeating(t.repeat) ? '↻ ' : '') + t.title }; }
      return { c: 'proj', t: '↻ ' + ((b.s.template || {}).title || '') };
    });
    const cls = ['mc', D.parse(day).getMonth() !== m ? 'out' : '', day === td ? 'today' : '', day === state.selDay ? 'sel' : '', wd === 5 ? 'sat' : '', wd === 6 ? 'sun' : ''].join(' ');
    return `<button class="${cls}" data-act="pick-day" data-day="${day}" aria-label="${D.fmtLong(day)} ${items.length}개">
      <span class="num">${D.parse(day).getDate()}</span>
      <span class="mc-items">${items.slice(0, 3).map((x) => `<span class="mi ${x.c}">${esc(x.t)}</span>`).join('')}</span>
      ${items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : ''}
    </button>`;
  }).join('');
  return `<div class="month"><div class="mh">${head}</div><div class="mg">${cells}</div></div>`;
}

/* ---------- 오버레이(상세·설정) ---------- */
function renderOverlay() {
  const ov = $('#overlay');
  const o = state.overlay;
  if (!o) { ov.hidden = true; ov.innerHTML = ''; document.body.classList.remove('ov-open'); return; }
  if (o.type === 'detail') {
    const t = byId(o.id);
    if (!t) { closeOverlay(); return; }
    const sheet = ov.querySelector('.sheet.detail-sheet');
    if (sheet && !ov.hidden) { renderDetailInto(sheet, t); return; }
    ov.innerHTML = `<div class="backdrop" data-act="close"></div><div class="sheet detail-sheet" role="dialog" aria-modal="true" aria-label="상세">${detailHTML(t)}</div>${datalistsHTML()}`;
  } else if (o.type === 'settings') {
    ov.innerHTML = `<div class="backdrop" data-act="close"></div><div class="sheet settings" role="dialog" aria-modal="true" aria-label="설정">${settingsHTML()}</div>`;
  }
  ov.hidden = false;
  document.body.classList.add('ov-open');
}
function closeOverlay() { state.overlay = null; state.confirmDelete = null; renderOverlay(); }

function openTask(id) {
  const t = byId(id); if (!t) return;
  state.selected[t.space] = id;
  state.confirmDelete = null;
  if (state.view === 'list' && !isMobile()) { renderMain(); return; }
  state.overlay = { type: 'detail', id };
  $('#overlay').innerHTML = '';
  renderOverlay();
  if (state.view === 'list') renderMain();
}

function settingsHTML() {
  const work = state.mode === 'work';
  const listBlock = (key, label) => `<div class="set-list">
      <h4>${label}</h4>
      ${listOf(key).map((v, i) => `<div class="set-item">
        <input id="set-${key}-${i}" value="${esc(v)}" data-set="${key}" data-old="${esc(v)}" aria-label="${label} 이름">
        <button class="icon-btn small" data-act="set-del" data-key="${key}" data-v="${esc(v)}" aria-label="${esc(v)} 삭제"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join('') || '<p class="muted small">아직 없어요.</p>'}
      <form class="set-add" data-form="set-add" data-key="${key}"><input name="v" placeholder="+ ${label} 추가" autocomplete="off"><button class="btn small ghost">추가</button></form>
    </div>`;
  const calRow = (mode) => {
    const st = gcal.status(mode);
    const em = gcal.email(mode);
    return `<div class="cal-row">
      <div><b>${MODE[mode].calFull}</b><div class="muted small">${st === 'none' ? '연결 안 됨' : esc(em) + (st === 'expired' ? ' · 새로고침 필요' : ' · 연결됨')}</div></div>
      <div class="btn-row">
        <button class="btn small ${st === 'none' ? 'primary' : 'ghost'}" data-act="gcal-connect" data-mode-for="${mode}">${st === 'none' ? '연결' : st === 'expired' ? '새로고침' : '다른 계정'}</button>
        ${st !== 'none' && !DEMO ? `<button class="btn small ghost" data-act="gcal-disconnect" data-mode-for="${mode}">해제</button>` : ''}
      </div>
    </div>`;
  };
  return `<div class="m-head"><h2>설정</h2><button class="icon-btn" data-act="close" aria-label="닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <h3>${work ? '업무 분류' : '개인 분류'} <span class="muted small">(${work ? '업무' : '개인'} 모드에서 편집 중)</span></h3>
    <p class="muted small">이름을 고치면 그 이름을 쓰던 ${work ? '업무' : '할 일'}도 모두 함께 바뀌어요. 삭제해도 이미 적힌 ${work ? '업무' : '할 일'}의 표시는 그대로 남아요.</p>
    <div class="set-grid">${work ? listBlock('workBrands', '브랜드') + listBlock('workMedia', '매체') : listBlock('personalCategories', '분류')}</div>
    <h3>구글 캘린더 (보기 전용)</h3>
    <p class="muted small">업무 모드에는 회사 계정, 개인 모드에는 개인 계정의 캘린더가 보여요.</p>
    ${calRow('work')}${calRow('personal')}
    <h3>계정</h3>
    <div class="cal-row"><div><b>${esc(state.user ? state.user.email : '')}</b><div class="muted small">${DEMO ? '데모 모드 · 이 브라우저에만 저장돼요' : '할 일은 이 계정에 저장돼요'}</div></div>
      <button class="btn small ghost" data-act="logout">${DEMO ? '데모 데이터 초기화' : '로그아웃'}</button></div>`;
}

/* ---------------- 이벤트 ---------------- */
document.addEventListener('click', async (e) => {
  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) { setMode(modeBtn.dataset.mode); return; }
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) { setView(viewBtn.dataset.view); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const detail = el.closest('.detail');
  const tid = detail ? detail.dataset.id : null;
  const t = tid ? byId(tid) : null;

  switch (act) {
    case 'login': store.signIn().catch(fail); break;
    case 'logout': closeOverlay(); store.signOut().catch(fail); break;
    case 'settings': state.overlay = { type: 'settings' }; renderOverlay(); break;
    case 'close': if (state.overlay) closeOverlay(); else { state.selected[state.mode] = null; renderMain(); } break;
    case 'toggle': e.preventDefault(); toggleDone(el.dataset.id); break;
    case 'open': openTask(el.dataset.id); break;
    case 'dp-done': state.showDayDone = !state.showDayDone; renderMain(); break;
    case 'toggle-done': state.showDone = !state.showDone; renderMain(); break;

    case 'prio': if (t) { saveTask(t.id, { priority: el.dataset.v }); refreshDetail(); } break;
    case 'status': if (t) { const v = el.dataset.v; saveTask(t.id, { status: v, done: v === 'done' }); refreshDetail(); } break;
    case 'repeat': if (t) { const v = el.dataset.v; await setRepeat(t.id, { type: v, days: v === 'weekly' ? (normalizeRule(t.repeat, t.doDate).days.length ? t.repeat.days : [D.weekdayMon(t.doDate)]) : [] }); refreshDetail(); } break;
    case 'wday': if (t) {
      const cur = normalizeRule(t.repeat, t.doDate).days; const d = Number(el.dataset.v);
      const days = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
      if (!days.length) { toast('요일을 하나 이상 골라 주세요'); break; }
      await setRepeat(t.id, { type: 'weekly', days }); refreshDetail();
    } break;
    case 'sub-toggle': if (t) { const subs = (t.subtasks || []).map((x, i) => (i === Number(el.dataset.i) ? { ...x, done: !x.done } : x)); saveTask(t.id, { subtasks: subs }); refreshDetail(); } break;
    case 'sub-del': if (t) { const subs = (t.subtasks || []).filter((x, i) => i !== Number(el.dataset.i)); saveTask(t.id, { subtasks: subs }); refreshDetail(true); } break;
    case 'delete': if (t) {
      if (state.confirmDelete !== t.id) { state.confirmDelete = t.id; refreshDetail(true); break; }
      state.confirmDelete = null;
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      state.selected[t.space] = null;
      Promise.resolve(store.deleteTask(t.id)).catch(fail);
      if (state.overlay) closeOverlay();
      renderMain(); toast('삭제했어요');
    } break;
    case 'stop-repeat': if (t) { await setRepeat(t.id, { type: 'none' }); refreshDetail(true); toast('반복을 멈췄어요. 이 회차는 남아 있어요.'); } break;

    case 'cal-prev': case 'cal-next': {
      const dir = act === 'cal-prev' ? -1 : 1;
      state.cursor = state.calView === 'week' ? D.addDays(state.cursor, 7 * dir) : D.addMonths(state.cursor, dir);
      state.selDay = state.calView === 'week' ? D.startOfWeek(state.cursor) : D.startOfMonth(state.cursor);
      if (state.calView === 'week' && D.startOfWeek(D.today()) === D.startOfWeek(state.cursor)) state.selDay = D.today();
      renderMain(); loadEvents(); break;
    }
    case 'cal-today': state.cursor = D.today(); state.selDay = D.today(); renderMain(); loadEvents(); break;
    case 'cal-view': state.calView = el.dataset.v; LS.set('calView', state.calView); state.cursor = state.selDay; renderMain(); loadEvents(); break;
    case 'pick-day': state.selDay = el.dataset.day; renderMain(); if (isMobile()) { const p = $('.day-panel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); } break;
    case 'show-tasks': state.showTasks = el.checked; renderMain(); break;
    case 'show-events': state.showEvents = el.checked; renderMain(); break;
    case 'gcal-connect': {
      const mode = el.dataset.modeFor || state.mode;
      try {
        const email = await gcal.connect(mode, el.dataset.modeFor && gcal.status(mode) === 'connected' ? '' : undefined);
        toast(`${MODE[mode].cal} 연결됨${email ? ': ' + email : ''}`);
        if (state.overlay && state.overlay.type === 'settings') renderOverlay();
        await loadEvents(); renderMain();
      } catch (err) { fail(err); }
      break;
    }
    case 'ev-toggle': {
      e.preventDefault();
      const ev = (state.events[state.mode] || []).find((x) => x.id === el.dataset.ev);
      if (!ev) break;
      const key = evKey(state.mode, ev);
      if (state.checks.has(key)) { state.checks.delete(key); Promise.resolve(store.setEventCheck(key, null)).catch(fail); } else {
        const d = { mode: state.mode, eventId: ev.id, date: ev.start, title: ev.title };
        state.checks.set(key, { ...d, id: key });
        Promise.resolve(store.setEventCheck(key, d)).catch(fail);
      }
      renderMain(); break;
    }
    case 'qslot': {
      const form = el.closest('form'); const hid = form.querySelector('[name="slot"]');
      const on = hid.value === el.dataset.v;
      hid.value = on ? '' : el.dataset.v;
      form.querySelectorAll('[data-act="qslot"]').forEach((b) => b.setAttribute('aria-pressed', String(!on && b === el)));
      if (!on) { const tm = form.querySelector('[name="doTime"]'); if (tm && tm.value && ((tm.value < '12:00') !== (el.dataset.v === 'am'))) tm.value = ''; }
      break;
    }
    case 'slot': if (t) {
      const v = el.dataset.v; const on = slotOf(t) === v;
      const patch = on ? { slot: '', doTime: '' } : { slot: v };
      if (!on && t.doTime && ((t.doTime < '12:00') !== (v === 'am'))) patch.doTime = '';
      saveTask(t.id, patch); refreshDetail();
    } break;
    case 'gcal-disconnect': { const mode = el.dataset.modeFor; gcal.disconnect(mode); state.events[mode] = []; renderOverlay(); renderMain(); break; }
    case 'set-del': {
      const key = el.dataset.key; const v = el.dataset.v;
      const next = listOf(key).filter((x) => x !== v);
      state.settings[key] = next; Promise.resolve(store.saveSettings({ [key]: next })).catch(fail); renderOverlay(); break;
    }
    default: break;
  }
});

function refreshDetail(force) {
  if (force) {
    const a = document.activeElement; if (a && a.closest && a.closest('.detail')) a.blur();
  }
  if (state.overlay && state.overlay.type === 'detail') renderOverlay();
  else renderMain();
}

function setMode(m) {
  if (m === state.mode) return;
  state.mode = m; LS.set('mode', m);
  state.confirmDelete = null;
  if (state.overlay && state.overlay.type === 'detail') state.overlay = null;
  render(); loadEvents();
}
function setView(v) {
  if (v === state.view) return;
  state.view = v; LS.set('view', v);
  if (v === 'calendar') { state.cursor = D.today(); state.selDay = D.today(); }
  if (state.overlay && state.overlay.type === 'detail') state.overlay = null;
  render(); loadEvents();
}

// 상세 입력 저장 (글자는 잠시 멈추면 저장, 날짜·분류는 바로 저장)
const timers = {};
function fieldSave(el, immediate) {
  const detail = el.closest('.detail'); if (!detail) return;
  const t = byId(detail.dataset.id); if (!t) return;
  const f = el.dataset.f;
  const run = () => {
    // 화면이 다시 그려졌으면 지금 화면에 있는 칸의 값을 씁니다
    const live = (el.id && document.getElementById(el.id)) || el;
    if (live !== el && live.closest('.detail') && live.closest('.detail').dataset.id !== t.id) return;
    el = live;
    if (f === 'sub') {
      const i = Number(el.dataset.i);
      const text = el.value.trim();
      const subs = (t.subtasks || []).map((x, j) => (j === i ? { ...x, text: text || x.text } : x));
      saveTask(t.id, { subtasks: subs }, { quiet: true });
      return;
    }
    let v = el.value;
    if (f === 'title') { v = v.replace(/\s*\n\s*/g, ' ').trim(); if (!v) { toast('내용을 비울 수 없어요'); el.value = t.title; return; } }
    if (f === 'doDate' && !v) { toast('할 날짜는 꼭 있어야 해요'); el.value = t.doDate; return; }
    if (['brand', 'media', 'category'].includes(f)) {
      v = v.trim();
      rememberName({ brand: 'workBrands', media: 'workMedia', category: 'personalCategories' }[f], v);
    }
    if (t[f] === v) return;
    if (f === 'doTime') { saveTask(t.id, { doTime: v, slot: v ? (v < '12:00' ? 'am' : 'pm') : (t.slot || '') }); refreshDetail(true); return; }
    saveTask(t.id, { [f]: v }, { quiet: ['title', 'memo', 'result'].includes(f) });
    if (['title', 'memo', 'result'].includes(f)) renderListOnly();
    if (f === 'doDate') refreshDetail(true);
  };
  clearTimeout(timers[f]);
  if (immediate) run(); else timers[f] = setTimeout(run, 600);
}

// 상세를 건드리지 않고 목록만 다시 그리기
function renderListOnly() {
  if (state.view !== 'list') { if (state.view === 'calendar') { const a = document.activeElement; if (!a || !$('#main').contains(a)) renderMain(); } return; }
  const rows = $('.rows');
  if (!rows) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = listHTML();
  const fresh = tmp.querySelector('.rows');
  if (fresh) rows.replaceWith(fresh);
  const left = modeTasks().filter((x) => !x.done).length;
  $('#subtitle').textContent = `${D.fmtLong(D.today())} · 남은 ${MODE[state.mode].noun} ${left}개`;
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.f && ['title', 'memo', 'result'].includes(el.dataset.f)) fieldSave(el, false);
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.f) { fieldSave(el, true); return; }
  if (el.dataset && el.dataset.set) {
    const key = el.dataset.set; const old = el.dataset.old; const v = el.value.trim();
    if (!v) { el.value = old; return; }
    if (v === old) return;
    if (listOf(key).includes(v)) { toast('이미 있는 이름이에요'); el.value = old; return; }
    const next = listOf(key).map((x) => (x === old ? v : x));
    state.settings[key] = next;
    const field = { workBrands: 'brand', workMedia: 'media', personalCategories: 'category' }[key];
    const space = key === 'personalCategories' ? 'personal' : 'work';
    state.tasks.forEach((x) => { if (x.space === space && x[field] === old) x[field] = v; });
    Promise.all([store.saveSettings({ [key]: next }), store.renameValue(space, field, old, v)]).then(() => toast('이름을 바꿨어요')).catch(fail);
    el.dataset.old = v;
    renderMain();
  }
  if (el.id === 'q-date') quickDate = el.value || D.today();
  if (el.name === 'doTime' && el.form && el.form.dataset.form === 'quick') {
    const v = el.value ? (el.value < '12:00' ? 'am' : 'pm') : '';
    const hid = el.form.querySelector('[name="slot"]'); if (hid) hid.value = v;
    el.form.querySelectorAll('[data-act="qslot"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }
});
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.f && ['title', 'memo', 'result'].includes(el.dataset.f)) fieldSave(el, true);
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (kind === 'quick') {
    const fd = new FormData(form);
    const data = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v).trim()]));
    if (form.id === 'q') quickDate = data.doDate || quickDate;
    if (!data.title || !data.doDate) { await addTask(data); return; }
    // 다시 그려지기 전에 입력칸을 비워 둡니다
    const titleId = `${form.id}-title`;
    const ti0 = document.getElementById(titleId); if (ti0) ti0.value = '';
    const id = await addTask(data);
    const ti = document.getElementById(titleId);
    if (!id) { if (ti) ti.value = data.title; return; }
    if (ti) { ti.value = ''; ti.focus(); }
    const f2 = document.getElementById(form.id);
    if (f2) { const tm = f2.querySelector('[name="doTime"]'); if (tm) tm.value = ''; const hid = f2.querySelector('[name="slot"]'); if (hid) hid.value = ''; f2.querySelectorAll('[data-act="qslot"]').forEach((b) => b.setAttribute('aria-pressed', 'false')); }
    if (form.id === 'dq' && data.doDate !== state.selDay) toast(`${D.fmtShort(data.doDate)}에 추가했어요`);
    if (data.doDate !== D.today() && form.id === 'q') toast(`${D.fmtShort(data.doDate)}에 추가했어요`);
  } else if (kind === 'sub') {
    const t = byId(form.closest('.detail').dataset.id);
    const text = form.text.value.trim();
    if (!t || !text) return;
    form.text.value = '';
    saveTask(t.id, { subtasks: [...(t.subtasks || []), { text, done: false }] });
    refreshDetail();
    setTimeout(() => { const n = document.getElementById('d-subnew'); if (n) n.focus(); }, 0);
  } else if (kind === 'set-add') {
    const key = form.dataset.key; const v = form.v.value.trim();
    if (!v) return;
    if (listOf(key).includes(v)) { toast('이미 있는 이름이에요'); return; }
    const next = [...listOf(key), v];
    state.settings[key] = next;
    Promise.resolve(store.saveSettings({ [key]: next })).catch(fail);
    renderOverlay();
    setTimeout(() => { const i = $(`form[data-key="${key}"] input`); if (i) i.focus(); }, 0);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.overlay) closeOverlay();
});

window.addEventListener('resize', () => {
  // 폰 ↔ PC 크기가 바뀌면 상세 표시 방식 조정
  if (!state.user || state.view !== 'list') return;
  if (!isMobile() && state.overlay && state.overlay.type === 'detail') { state.overlay = null; renderOverlay(); renderMain(); }
});

init();
