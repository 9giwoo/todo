// 구글 캘린더 보기(읽기 전용). 업무 모드와 개인 모드가 서로 다른 구글 계정을 씁니다.
import { today, addDays, ymd, pad } from './dates.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

function normalize(e, cal) {
  const allDay = !!(e.start && e.start.date);
  let start; let endEx; let time;
  if (allDay) { start = e.start.date; endEx = e.end.date; time = '종일'; } else {
    const s = new Date(e.start.dateTime); const en = new Date(e.end.dateTime);
    start = ymd(s);
    const endDay = ymd(en);
    endEx = (en.getHours() === 0 && en.getMinutes() === 0 && endDay > start) ? endDay : addDays(endDay, 1);
    time = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  }
  return { id: `${cal.id}|${e.id}`, title: e.summary || '(제목 없음)', start, endEx, time, allDay, color: cal.backgroundColor || '#8A919E', link: e.htmlLink || '' };
}

// 내가 포함된 일정만: 참석자 목록이 있으면 내가 들어 있고 거절하지 않은 일정, 없으면 내 캘린더에 직접 만든 일정
function includesMe(e) {
  if (e.eventType === 'workingLocation') return false;
  const att = Array.isArray(e.attendees) ? e.attendees : [];
  if (!att.length) return true;
  const me = att.find((a) => a.self);
  if (me) return me.responseStatus !== 'declined';
  return !!(e.organizer && e.organizer.self) || !!(e.creator && e.creator.self);
}

export function eventsOnDay(events, day) { return events.filter((e) => e.start <= day && e.endEx > day); }

export function createGcal({ clientId, demo }) {
  let gis = null;
  const tokens = LS.get('gcal_tokens', {});
  const calCache = {};

  function loadGis() {
    if (gis) return gis;
    gis = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gis = null; reject(new Error('구글 로그인 도구를 불러오지 못했어요')); };
      document.head.appendChild(s);
    });
    return gis;
  }
  const valid = (mode) => !!(tokens[mode] && tokens[mode].exp > Date.now() + 60_000);

  async function api(token, path) {
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { const e = new Error('expired'); e.expired = true; throw e; }
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* 무시 */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function demoEvents(mode, from, to) {
    const t = today();
    const E = (d, time, title) => ({ id: `${mode}${d}${time}`, title, start: addDays(t, d), endEx: addDays(t, d + 1), time, allDay: time === '종일', color: '#8A919E', link: '' });
    const list = mode === 'work'
      ? [E(0, '10:00', '주간 업무 회의'), E(0, '16:00', '디자인 시안 리뷰'), E(2, '14:00', '신규 광고주 미팅'), E(-5, '15:00', '분기 성과 리뷰'), E(8, '종일', '하반기 전략 워크숍'), E(11, '19:00', '팀 회식')]
      : [E(0, '19:30', '가족 저녁 식사'), E(1, '07:00', '헬스장'), E(2, '종일', '엄마 생신'), E(3, '20:00', '대학 동기 모임'), E(5, '12:00', '지인 결혼식'), E(12, '18:00', '동창 모임')];
    return list.filter((e) => e.start < to && e.endEx > from);
  }

  return {
    status(mode) { if (demo) return 'connected'; if (valid(mode)) return 'connected'; return tokens[mode] ? 'expired' : 'none'; },
    email(mode) { return demo ? (mode === 'work' ? 'me@company.com' : 'me@gmail.com') : (tokens[mode] && tokens[mode].email) || ''; },

    // 버튼을 눌렀을 때만 호출하세요(팝업이 뜹니다)
    async connect(mode, emailHint) {
      if (demo) return this.email(mode);
      if (!clientId) throw new Error('config.js에 GOOGLE_CLIENT_ID가 없어요');
      await loadGis();
      const hint = emailHint || (tokens[mode] && tokens[mode].email) || '';
      const tok = await new Promise((resolve, reject) => {
        const c = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          hint: hint || undefined,
          prompt: hint ? '' : 'select_account',
          callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
          error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? '연결 창이 닫혔어요' : '연결하지 못했어요')),
        });
        c.requestAccessToken();
      });
      const entry = { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000, email: hint };
      try { const p = await api(entry.token, '/users/me/calendarList/primary'); entry.email = p.id; } catch { /* 이메일 확인 실패는 무시 */ }
      tokens[mode] = entry;
      delete calCache[mode];
      LS.set('gcal_tokens', tokens);
      return entry.email;
    },
    disconnect(mode) {
      const t = tokens[mode];
      if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t.token, () => {}); } catch { /* 무시 */ } }
      delete tokens[mode]; delete calCache[mode];
      LS.set('gcal_tokens', tokens);
      Object.keys(localStorage).filter((k) => k.startsWith(`gcal_ev_${mode}_`)).forEach((k) => LS.del(k));
    },

    // from 이상, to 미만 날짜의 일정. 연결이 만료되면 저장된 일정 + needAuth를 돌려줍니다
    async events(mode, from, to) {
      if (demo) return { events: demoEvents(mode, from, to) };
      const key = `gcal_ev_${mode}_${from}_${to}`;
      const saved = LS.get(key, null);
      const cached = Array.isArray(saved) ? saved : (saved && saved.events) || null;
      const savedAt = (saved && !Array.isArray(saved) && saved.at) || 0;
      if (!tokens[mode]) return { events: [], none: true };
      if (!valid(mode)) return { events: cached || [], needAuth: true, savedAt };
      const tk = tokens[mode].token;
      try {
        if (!calCache[mode]) {
          const j = await api(tk, '/users/me/calendarList?minAccessRole=reader');
          // 업무: 내 기본 캘린더만(팀·공유 캘린더 제외) / 개인: 구글 캘린더에서 표시 중인 캘린더
          calCache[mode] = (j.items || []).filter((c) => (mode === 'work' ? c.primary : (c.selected || c.primary)));
        }
        const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '500', timeMin: new Date(from + 'T00:00:00').toISOString(), timeMax: new Date(to + 'T00:00:00').toISOString() });
        const lists = await Promise.all(calCache[mode].map((c) => api(tk, `/calendars/${encodeURIComponent(c.id)}/events?${p}`)
          .then((j) => (j.items || []).filter((e) => e.status !== 'cancelled' && e.start && includesMe(e)).map((e) => normalize(e, c)))
          .catch((e) => { if (e.expired) throw e; return []; })));
        const events = lists.flat().sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
        LS.set(key, { events, at: Date.now() });
        return { events };
      } catch (e) {
        if (e.expired) { tokens[mode].exp = 0; LS.set('gcal_tokens', tokens); return { events: cached || [], needAuth: true, savedAt }; }
        return { events: cached || [], error: e.message, savedAt };
      }
    },
  };
}
