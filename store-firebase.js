// Firebase(Firestore + 로그인) 저장소. 데이터 경로: users/{uid}/tasks, users/{uid}/series, users/{uid}/meta/settings
const V = '10.14.1';
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, runTransaction, writeBatch, getDocs,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

const millis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : Date.now()));
const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined ? null : v)));

export function createFirebaseStore(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  let uid = null;
  let unsubs = [];
  let handlers = null;
  let since = null;
  let undoneMap = new Map();
  let recentMap = new Map();
  let recentUnsub = null;

  const col = (name) => collection(db, 'users', uid, name);
  const settingsRef = () => doc(db, 'users', uid, 'meta', 'settings');
  const toTask = (d) => {
    const x = d.data({ serverTimestamps: 'estimate' });
    return { ...x, id: d.id, createdAt: millis(x.createdAt), updatedAt: millis(x.updatedAt), completedAt: x.completedAt ? millis(x.completedAt) : null };
  };
  const emitTasks = () => {
    const m = new Map(recentMap);
    undoneMap.forEach((v, k) => m.set(k, v));
    handlers.onTasks([...m.values()]);
  };
  const onErr = (e) => handlers && handlers.onError && handlers.onError(e);

  function subscribeRecent() {
    if (recentUnsub) recentUnsub();
    recentUnsub = onSnapshot(query(col('tasks'), where('doDate', '>=', since)), (snap) => {
      recentMap = new Map(snap.docs.map((d) => [d.id, toTask(d)]));
      emitTasks();
    }, onErr);
  }

  return {
    kind: 'firebase',
    init(onAuth) {
      onAuthStateChanged(auth, (u) => {
        uid = u ? u.uid : null;
        onAuth(u ? { uid: u.uid, email: u.email, name: u.displayName || u.email } : null);
      });
    },
    async signIn() {
      const p = new GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, p);
    },
    async signOut() { this.unwatch(); await signOut(auth); },

    // 안 끝난 업무 전체 + since 이후 날짜의 업무(완료 포함)를 실시간으로 받습니다
    watch(h, sinceDate) {
      this.unwatch();
      handlers = h;
      since = sinceDate;
      unsubs.push(onSnapshot(query(col('tasks'), where('done', '==', false)), (snap) => {
        undoneMap = new Map(snap.docs.map((d) => [d.id, toTask(d)]));
        emitTasks();
      }, onErr));
      subscribeRecent();
      unsubs.push(onSnapshot(col('series'), (snap) => {
        h.onSeries(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }, onErr));
      unsubs.push(onSnapshot(settingsRef(), (snap) => { h.onSettings(snap.exists() ? snap.data() : {}); }, onErr));
      // 구글 캘린더 일정의 완료 체크(캘린더 자체는 건드리지 않고 이 앱에만 저장)
      unsubs.push(onSnapshot(col('eventChecks'), (snap) => { if (h.onChecks) h.onChecks(snap.docs.map((d) => ({ ...d.data(), id: d.id }))); }, onErr));
    },
    unwatch() {
      unsubs.forEach((u) => u()); unsubs = [];
      if (recentUnsub) recentUnsub(); recentUnsub = null;
      undoneMap = new Map(); recentMap = new Map();
    },
    setSince(d) { if (uid && handlers && d < since) { since = d; subscribeRecent(); } },

    async addTask(data) {
      const ref = await addDoc(col('tasks'), { ...clean(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      return ref.id;
    },
    // 오프라인에서도 바로 반영되도록 await 없이 써도 됩니다
    updateTask(id, patch) {
      const p = clean(patch);
      if (patch.done === true) p.completedAt = serverTimestamp();
      if (patch.done === false) p.completedAt = null;
      return updateDoc(doc(col('tasks'), id), { ...p, updatedAt: serverTimestamp() });
    },
    deleteTask(id) { return deleteDoc(doc(col('tasks'), id)); },
    // 반복 회차는 정해진 id로 한 번만 만듭니다(여러 기기가 동시에 만들어도 중복 없음)
    async createTaskIfAbsent(id, data) {
      const ref = doc(col('tasks'), id);
      await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists()) tx.set(ref, { ...clean(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      });
    },
    async addSeries(data) { const ref = await addDoc(col('series'), clean(data)); return ref.id; },
    updateSeries(id, patch) { return updateDoc(doc(col('series'), id), clean(patch)); },
    saveSettings(patch) { return setDoc(settingsRef(), clean(patch), { merge: true }); },
    setEventCheck(key, data) { const ref = doc(col('eventChecks'), key); return data ? setDoc(ref, { ...clean(data), checkedAt: serverTimestamp() }) : deleteDoc(ref); },

    // 분류 이름을 바꾸면 그 이름을 쓰는 모든 업무(지난 기록 포함)와 반복 설정도 함께 바꿉니다
    async renameValue(space, field, oldName, newName) {
      const snap = await getDocs(query(col('tasks'), where('space', '==', space), where(field, '==', oldName)));
      const ser = await getDocs(query(col('series'), where('space', '==', space)));
      const refs = [];
      snap.docs.forEach((d) => refs.push([d.ref, { [field]: newName }]));
      ser.docs.forEach((d) => { const t = d.data().template || {}; if (t[field] === oldName) refs.push([d.ref, { [`template.${field}`]: newName }]); });
      for (let i = 0; i < refs.length; i += 400) {
        const b = writeBatch(db);
        refs.slice(i, i + 400).forEach(([r, p]) => b.update(r, p));
        await b.commit();
      }
    },
  };
}
