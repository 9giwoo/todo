// 날짜는 모두 'YYYY-MM-DD' 문자열(현지 시간)로 다룹니다.
export const WD = ['월', '화', '수', '목', '금', '토', '일']; // 월요일 시작
const WD_SUN = ['일', '월', '화', '수', '목', '금', '토'];

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
export const addMonths = (s, n) => { const d = parse(s); return ymd(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const weekdayMon = (s) => (parse(s).getDay() + 6) % 7; // 월=0 … 일=6
export const startOfWeek = (s) => addDays(s, -weekdayMon(s));
export const startOfMonth = (s) => s.slice(0, 8) + '01';
export const lastDayOfMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();

export const md = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const fmtShort = (s) => `${md(s)} (${WD_SUN[parse(s).getDay()]})`;
export const fmtLong = (s) => { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD_SUN[d.getDay()]})`; };
export const fmtYearMonth = (s) => { const d = parse(s); return `${d.getFullYear()}년 ${d.getMonth() + 1}월`; };

export function fmtRelative(s, t = today()) {
  const n = diffDays(t, s);
  if (n === 0) return '오늘';
  if (n === 1) return '내일';
  if (n === -1) return '어제';
  return fmtShort(s);
}

export function weekLabel(start) {
  const end = addDays(start, 6);
  const a = parse(start); const b = parse(end);
  return a.getMonth() === b.getMonth()
    ? `${a.getMonth() + 1}월 ${a.getDate()}일 – ${b.getDate()}일`
    : `${a.getMonth() + 1}월 ${a.getDate()}일 – ${b.getMonth() + 1}월 ${b.getDate()}일`;
}

// 월 보기용 6주(42일) 날짜, 월요일 시작
export function monthGrid(anyDayInMonth) {
  const start = startOfWeek(startOfMonth(anyDayInMonth));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
