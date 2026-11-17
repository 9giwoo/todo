// 데모 저장소: 이 브라우저에만 저장(localStorage). Firebase 설정 전 미리 써 보기용
import { today, addDays, weekdayMon } from './dates.js';

const KEY = 'todo_demo_v1';

function seed() {
  const t = today();
  const wd = weekdayMon(t);
  const mon = addDays(t, -wd);           // 이번 주 월요일
  const lastFri = addDays(mon, -3);      // 지난주 금요일
  const prevFri = addDays(mon, -10);     // 2주 전 금요일
  let n = 0;
  const id = () => `d${++n}`;
  const now = Date.now();
  const tasks = {};
  const add = (o) => { const i = id(); tasks[i] = { id: i, priority: 'mid', status: 'todo', done: false, brand: '', media: '', category: '', memo: '', dueDate: '', dueTime: '', subtasks: [], repeat: { type: 'none', days: [] }, seriesId: null, createdAt: now + n, updatedAt: now, completedAt: null, ...o }; return i; };

  add({ space: 'work', brand: '루미에르', media: '메타', title: '11월 4주차 광고 소재 교체', priority: 'high', status: 'doing', doDate: t, dueDate: t, dueTime: '18:00', memo: '신규 시안 3종 중 B안 우선 집행', subtasks: [{ text: '시안 최종본 받기', done: true }, { text: '광고 관리자 업로드', done: false }] });
  add({ space: 'work', brand: '모아핀테크', media: '구글', title: '전환 추적 태그 점검', priority: 'high', doDate: addDays(t, 1), dueDate: addDays(t, 1) });
  add({ space: 'work', brand: '한빛식품', media: '네이버', title: '검색광고 키워드 확장안 작성', doDate: addDays(t, 1), dueDate: addDays(t, 2) });
  add({ space: 'work', brand: '한빛식품', media: '카카오', title: '모먼트 예산 증액 요청 회신', status: 'waiting', doDate: addDays(t, 2), dueDate: addDays(t, 3), memo: '광고주 답변 대기 중' });
  add({ space: 'work', brand: '루미에르', title: '월간 성과 리포트 작성', status: 'doing', doDate: addDays(t, 3), dueDate: addDays(t, 4), memo: '전월 대비 ROAS 하락 원인 분석 포함', subtasks: [{ text: '매체별 데이터 추출', done: true }, { text: '요약 표 작성', done: true }, { text: '인사이트 정리', done: false }, { text: '팀장 검토 요청', done: false }] });
  add({ space: 'work', media: '유튜브', title: '프리롤 영상 규격 변경사항 확인', priority: 'low', doDate: addDays(t, 4) });
  add({ space: 'work', brand: '모아핀테크', media: '메타', title: '리타게팅 오디언스 갱신', doDate: addDays(t, -3), done: true, status: 'done', completedAt: now - 3e8 });

  const series = {
    s1: { id: 's1', space: 'work', rule: { type: 'weekly', days: [4] }, anchorDate: prevFri, lastDate: prevFri, active: true,
      template: { title: '주간 성과 보고 메일 발송', brand: '루미에르', media: '', category: '', priority: 'mid', memo: '광고주에게 주간 리포트 요약 발송', dueTime: '17:00', subtasks: [], dueOffset: 0 } },
    s2: { id: 's2', space: 'work', rule: { type: 'weekly', days: [0] }, anchorDate: addDays(mon, -7), lastDate: addDays(mon, -7), active: true,
      template: { title: '팀 주간회의 안건 정리', brand: '', media: '', category: '', priority: 'low', memo: '', dueTime: '', subtasks: [], dueOffset: null } },
    s3: { id: 's3', space: 'personal', rule: { type: 'weekly', days: [1] }, anchorDate: addDays(mon, -6), lastDate: addDays(mon, -6), active: true,
      template: { title: '헬스장 PT 예약', brand: '', media: '', category: '건강', priority: 'mid', memo: '', dueTime: '', subtasks: [], dueOffset: null } },
  };
  add({ space: 'work', brand: '루미에르', title: '주간 성과 보고 메일 발송', doDate: prevFri, dueDate: prevFri, dueTime: '17:00', done: true, status: 'done', seriesId: 's1', repeat: { type: 'weekly', days: [4] }, completedAt: now - 9e8 });
  add({ space: 'work', title: '팀 주간회의 안건 정리', priority: 'low', doDate: addDays(mon, -7), done: true, status: 'done', seriesId: 's2', repeat: { type: 'weekly', days: [0] }, completedAt: now - 6e8 });
  add({ space: 'personal', category: '건강', title: '헬스장 PT 예약', doDate: addDays(mon, -6), done: true, status: 'done', seriesId: 's3', repeat: { type: 'weekly', days: [1] }, completedAt: now - 5e8 });
  // 위 반복 시리즈의 lastDate를 지난 회차로 두었으므로, 앱이 열리면 밀린 회차와 다음 회차가 자동으로 생깁니다
  series.s1.lastDate = prevFri; void lastFri;

  add({ space: 'personal', category: '집', title: '세탁소 맡긴 코트 찾기', doDate: addDays(t, -2), memo: '영수증 지갑에 있음' });
  add({ space: 'personal', category: '가족', title: '엄마 생신 선물 주문', priority: 'high', status: 'doing', doDate: t, dueDate: addDays(t, 2), subtasks: [{ text: '선물 고르기', done: true }, { text: '주문·결제', done: false }, { text: '케이크 예약', done: false }] });
  add({ space: 'personal', title: '여권 갱신 서류 준비', priority: 'low', doDate: addDays(t, 5), memo: '증명사진 새로 찍기' });
  add({ space: 'personal', category: '집', title: '주말 장보기 목록 정리', priority: 'low', doDate: addDays(t, 5) });

  const settings = {
    workBrands: ['루미에르', '모아핀테크', '한빛식품'],
    workMedia: ['메타', '구글', '네이버', '카카오', '유튜브'],
    personalCategories: ['집', '건강', '가족'],
  };
  return { tasks, series, settings, n };
}

export function createLocalStore() {
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { data = null; }
  if (!data) data = seed();
  let h = null;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* 무시 */ } };
  const emit = () => {
    save();
    if (!h) return;
    h.onTasks(Object.values(data.tasks).map((x) => ({ ...x })));
    h.onSeries(Object.values(data.series).map((x) => ({ ...x })));
    h.onSettings({ ...data.settings });
    if (h.onChecks) h.onChecks(Object.values(data.checks || {}));
  };
  const later = () => setTimeout(emit, 0);
  const nid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  return {
    kind: 'local',
    init(onAuth) { setTimeout(() => onAuth({ uid: 'demo', email: 'demo@example.com', name: '데모' }), 0); },
    async signIn() {},
    async signOut() { localStorage.removeItem(KEY); location.reload(); },
    watch(handlers) { h = handlers; later(); },
    unwatch() { h = null; },
    setSince() {},
    async addTask(d) { const id = nid('t'); data.tasks[id] = { ...d, id, createdAt: Date.now(), updatedAt: Date.now(), completedAt: null }; later(); return id; },
    async updateTask(id, patch) {
      if (!data.tasks[id]) return;
      const p = { ...patch, updatedAt: Date.now() };
      if (patch.done === true) p.completedAt = Date.now();
      if (patch.done === false) p.completedAt = null;
      Object.assign(data.tasks[id], p); later();
    },
    async deleteTask(id) { delete data.tasks[id]; later(); },
    async createTaskIfAbsent(id, d) { if (!data.tasks[id]) { data.tasks[id] = { ...d, id, createdAt: Date.now(), updatedAt: Date.now(), completedAt: null }; later(); } },
    async addSeries(d) { const id = nid('s'); data.series[id] = { ...d, id }; later(); return id; },
    async updateSeries(id, patch) {
      const s = data.series[id]; if (!s) return;
      Object.entries(patch).forEach(([k, v]) => {
        if (k.startsWith('template.')) { s.template = { ...(s.template || {}), [k.slice(9)]: v }; } else s[k] = v;
      });
      later();
    },
    async saveSettings(patch) { data.settings = { ...data.settings, ...patch }; later(); },
    async setEventCheck(key, d) { data.checks = data.checks || {}; if (d) data.checks[key] = { ...d, id: key, checkedAt: Date.now() }; else delete data.checks[key]; later(); },
    async renameValue(space, field, oldName, newName) {
      Object.values(data.tasks).forEach((t) => { if (t.space === space && t[field] === oldName) t[field] = newName; });
      Object.values(data.series).forEach((s) => { if (s.space === space && s.template && s.template[field] === oldName) s.template[field] = newName; });
      later();
    },
  };
}
