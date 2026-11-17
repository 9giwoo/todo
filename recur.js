// 반복 업무 규칙
// rule: { type: 'none'|'daily'|'weekdays'|'weekly'|'monthly', days: [0..6] (월=0, 매주일 때) }
// 반복 업무는 "시리즈(series)" 하나와 날짜별 "회차(task)"로 저장됩니다.
// - 오늘까지의 회차는 모두 만들어 둡니다(완료하지 않으면 밀린 회차로 남음).
// - 오늘 이후로는 다음 회차 하나만 미리 만들어 둡니다.
import { addDays, parse, ymd, weekdayMon, lastDayOfMonth, WD } from './dates.js';

export const REPEAT_TYPES = [
  ['none', '안 함'], ['daily', '매일'], ['weekdays', '평일'], ['weekly', '매주'], ['monthly', '매월'],
];

export function isRepeating(rule) { return !!rule && rule.type && rule.type !== 'none'; }

export function normalizeRule(rule, anchor) {
  if (!isRepeating(rule)) return { type: 'none', days: [] };
  const r = { type: rule.type, days: Array.isArray(rule.days) ? [...new Set(rule.days)].sort() : [] };
  if (r.type === 'weekly' && !r.days.length) r.days = [weekdayMon(anchor)];
  if (r.type !== 'weekly') r.days = [];
  return r;
}

// after 다음(초과)으로 오는 첫 반복 날짜
export function nextDate(rule, anchor, after) {
  const r = normalizeRule(rule, anchor);
  if (r.type === 'daily') return addDays(after, 1);
  if (r.type === 'weekdays') {
    let d = addDays(after, 1);
    while (weekdayMon(d) > 4) d = addDays(d, 1);
    return d;
  }
  if (r.type === 'weekly') {
    let d = addDays(after, 1);
    for (let i = 0; i < 7; i++) { if (r.days.includes(weekdayMon(d))) return d; d = addDays(d, 1); }
    return d;
  }
  if (r.type === 'monthly') {
    const dom = parse(anchor).getDate();
    const a = parse(after);
    for (let k = 0; k < 3; k++) {
      const y = a.getFullYear(); const m = a.getMonth() + k;
      const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12;
      const cand = ymd(new Date(yy, mm, Math.min(dom, lastDayOfMonth(yy, mm))));
      if (cand > after) return cand;
    }
  }
  return null;
}

export function ruleText(rule, anchor) {
  const r = normalizeRule(rule, anchor || '2000-01-03');
  if (r.type === 'daily') return '매일';
  if (r.type === 'weekdays') return '평일';
  if (r.type === 'weekly') return '매주 ' + r.days.map((d) => WD[d]).join('·');
  if (r.type === 'monthly') return anchor ? `매월 ${parse(anchor).getDate()}일` : '매월';
  return '';
}

// 만들어야 할 회차 날짜 목록과 새 lastDate
export function planGeneration(series, todayStr, max = 60) {
  const dates = [];
  if (!series.active || !isRepeating(series.rule)) return { dates, lastDate: series.lastDate };
  let last = series.lastDate;
  let d = nextDate(series.rule, series.anchorDate, last);
  while (d && d <= todayStr && dates.length < max) { dates.push(d); last = d; d = nextDate(series.rule, series.anchorDate, last); }
  if (last <= todayStr && d) { dates.push(d); last = d; } // 오늘 이후 다음 회차 하나
  return { dates, lastDate: last };
}

// 캘린더에 미리 보여 줄 앞으로의 회차(아직 만들지 않은 것)
export function projectedDates(series, from, to, max = 62) {
  const out = [];
  if (!series.active || !isRepeating(series.rule)) return out;
  let d = nextDate(series.rule, series.anchorDate, series.lastDate);
  while (d && d <= to && out.length < max) { if (d >= from) out.push(d); d = nextDate(series.rule, series.anchorDate, d); }
  return out;
}

export const TEMPLATE_FIELDS = ['title', 'brand', 'media', 'category', 'priority', 'memo', 'dueTime', 'doTime', 'slot'];

export function templateFromTask(t) {
  const tpl = {};
  TEMPLATE_FIELDS.forEach((k) => { tpl[k] = t[k] ?? ''; });
  tpl.subtasks = (t.subtasks || []).map((s) => s.text);
  tpl.dueOffset = t.dueDate ? Math.round((parse(t.dueDate) - parse(t.doDate)) / 86400000) : null;
  return tpl;
}

export function taskFromTemplate(series, date) {
  const tpl = series.template || {};
  return {
    space: series.space,
    title: tpl.title || '',
    brand: tpl.brand || '',
    media: tpl.media || '',
    category: tpl.category || '',
    priority: tpl.priority || 'mid',
    memo: tpl.memo || '',
    dueTime: tpl.dueTime || '',
    doTime: tpl.doTime || '',
    slot: tpl.slot || '',
    subtasks: (tpl.subtasks || []).map((text) => ({ text, done: false })),
    doDate: date,
    dueDate: tpl.dueOffset != null ? addDays(date, tpl.dueOffset) : '',
    status: 'todo',
    done: false,
    seriesId: series.id,
    repeat: normalizeRule(series.rule, series.anchorDate),
  };
}
