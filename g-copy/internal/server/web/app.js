'use strict';

// ── small helpers ───────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

// h builds DOM nodes. Strings always become text nodes, so file and folder
// names can never be interpreted as markup.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

const nf = new Intl.NumberFormat('ko-KR');
const num = (n) => nf.format(n || 0);

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1000) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < units.length - 1);
  return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + '초';
  if (sec < 3600) return Math.floor(sec / 60) + '분 ' + (sec % 60) + '초';
  return Math.floor(sec / 3600) + '시간 ' + Math.floor((sec % 3600) / 60) + '분';
}

function baseName(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// Long paths are cut at the front (the end is what tells folders apart).
// The mark keeps punctuation such as a leading "/" where it belongs.
const tailPath = (p) => '\u200E' + p;

function joinPath(a, b) {
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}

// Present only inside the desktop app (see desktop/preload.js). In a plain
// browser everything below that uses it is simply skipped.
const native = window.gcopyNative || null;
if (native) document.body.classList.add('native');

// Preferences live in the engine (see /api/settings), so they survive
// restarts in the desktop app, whose window address changes every launch.
const store = {
  data: {},
  queue: Promise.resolve(),
  async load() {
    try { this.data = await api('/api/settings'); } catch { /* start with defaults */ }
  },
  get(key, fallback) { return this.data[key] ?? fallback; },
  set(key, value) {
    this.data[key] = value;
    const snapshot = JSON.parse(JSON.stringify(this.data));
    this.queue = this.queue.then(() => api('/api/settings', snapshot)).catch(() => {}); // saved in order
  },
};

// ── server calls ────────────────────────────────────────────────────────

function block(msg) { $('blocker-msg').textContent = msg; $('blocker').hidden = false; }
function unblock() { $('blocker').hidden = true; }

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    block('G-Copy와 연결이 끊어졌습니다. 앱이 실행 중인지 확인하세요. 다시 연결되면 이 화면은 자동으로 돌아옵니다.');
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    block(data.error || '세션이 만료되었습니다.');
    throw new Error('unauthorized');
  }
  unblock();
  if (!res.ok) throw new Error(data.error || '오류가 발생했습니다 (' + res.status + ')');
  return data;
}

// ── state ───────────────────────────────────────────────────────────────

const state = {
  volumes: [],     // last known disks, for icons
  mode: 'setup',   // setup | running | finished
  sources: [],     // { path, isVolume }
  dests: [],       // { path, isVolume, free, extraEl }
  job: null,
};

const FINISHED = ['done', 'failed', 'cancelled'];
const isVolume = (p) => state.volumes.some((v) => v.path === p && v.kind !== 'home');
const item = (p) => ({ path: p, isVolume: isVolume(p) });

function setMode(mode) {
  state.mode = mode;
  $('app').dataset.mode = mode;
}

function options() {
  return {
    sources: state.sources.map((s) => s.path),
    destinations: state.dests.map((d) => d.path),
    algo: $('opt-algo').value,
    subfolder: $('opt-subfolder').checked,
    reverify: $('opt-reverify').checked,
  };
}

// ── lanes ───────────────────────────────────────────────────────────────

function card(item, kind, index) {
  const extra = h('div', { class: 'extra' });
  if (kind === 'dst') item.extraEl = extra;
  return h('li', { class: 'card' },
    h('span', { class: 'glyph' }, icon(item.isVolume ? 'disk' : 'folder')),
    h('span', { class: 'name', title: item.path }, baseName(item.path)),
    h('span', { class: 'path', title: item.path }, tailPath(item.path)),
    h('button', {
      class: 'iconbtn', type: 'button', 'aria-label': baseName(item.path) + ' 빼기',
      onclick: () => { (kind === 'src' ? state.sources : state.dests).splice(index, 1); saveDests(); renderSetup(); },
    }, icon('x')),
    extra,
  );
}

function saveDests() { store.set('dests', state.dests.map((d) => d.path)); }

function renderLanes() {
  $('src-list').replaceChildren(...state.sources.map((s, i) => card(s, 'src', i)));
  $('dst-list').replaceChildren(...state.dests.map((d, i) => card(d, 'dst', i)));
}

function renderSetup() {
  renderLanes();
  for (const d of state.dests) {
    if (d.free != null) d.extraEl.replaceChildren(h('span', {}, '여유 공간 ' + fmtBytes(d.free)));
  }

  const many = state.sources.length > 1;
  const sub = $('opt-subfolder');
  if (many) sub.checked = true;
  sub.disabled = many;

  const ready = state.sources.length > 0 && state.dests.length > 0;
  $('btn-start').disabled = !ready;
  $('start-err').hidden = true;

  let hint = '';
  if (!state.sources.length) hint = '원본을 추가하세요';
  else if (!state.dests.length) hint = '대상을 추가하세요';
  else {
    const d = state.dests[0].path;
    const first = sub.checked ? joinPath(d, baseName(state.sources[0].path)) : d;
    const more = state.sources.length * state.dests.length - 1;
    hint = '복사 위치:  ' + first + (more > 0 ? '  외 ' + more + '곳' : '');
  }
  $('hint').textContent = hint;
}

function destExtra(job, i) {
  const d = job.dests[i];
  const out = [];
  if (!d) return out;
  const finished = FINISHED.includes(job.status);
  if (job.status === 'scanning' || job.status === 'comparing') return [h('span', {}, '대기 중')];
  if (d.complete) {
    out.push(h('span', { class: 'ok' }, d.copied > 0 ? '✓ ' + num(d.copied) + '개 복사·검증' : d.reverified > 0 ? '✓ ' + num(d.reverified) + '개 재검증' : '✓ 이미 최신'));
  } else {
    out.push(h('span', {}, num(d.copied) + '개 복사·검증'));
  }
  if (d.copied > 0 && d.reverified > 0) out.push(h('span', {}, '재검증 ' + num(d.reverified)));
  if (d.skipped > 0) out.push(h('span', {}, '건너뜀 ' + num(d.skipped)));
  if (d.replaced > 0) out.push(h('span', {}, '교체 ' + num(d.replaced)));
  if (d.failed > 0) out.push(h('span', { class: 'bad' }, '실패 ' + num(d.failed)));
  if (d.stopped) out.push(h('span', { class: 'bad' }, '중단됨'));
  if (finished) {
    out.push(h('button', { class: 'link', type: 'button', onclick: () => reveal(d) }, '폴더 열기'));
    for (const r of d.reports) out.push(h('span', { class: 'report', title: r }, '리포트: ' + baseName(r)));
  }
  return out;
}

async function reveal(d) {
  for (const p of [d.folders[0], d.path]) {
    try { await api('/api/reveal', { path: p }); return; } catch { /* try the next one */ }
  }
}

// ── running ─────────────────────────────────────────────────────────────

function renderRun(job) {
  const track = $('run-track');
  const scanned = num(job.scanFiles) + '개 파일 · ' + fmtBytes(job.scanBytes);
  let phase, pct = '', stats, file = '';

  if (job.status === 'scanning') {
    phase = '원본을 읽는 중'; stats = scanned;
  } else if (job.status === 'comparing') {
    phase = '대상과 비교하는 중'; stats = scanned;
  } else {
    phase = '복사하고 검증하는 중';
    const p = job.workTotal > 0 ? Math.min(99, Math.floor((job.workDone / job.workTotal) * 100)) : 0;
    pct = p + '%';
    $('run-fill').style.width = (job.workTotal > 0 ? (job.workDone / job.workTotal) * 100 : 0) + '%';
    const parts = [fmtBytes(job.speed) + '/s'];
    if (job.eta > 0) parts.push('남은 시간 ' + fmtDur(job.eta));
    parts.push('복사 ' + num(job.filesCopied));
    if (job.filesSkipped) parts.push('건너뜀 ' + num(job.filesSkipped));
    if (job.filesVerified) parts.push('재검증 ' + num(job.filesVerified));
    if (job.filesFailed) parts.push('실패 ' + num(job.filesFailed));
    stats = parts.join(' · ');
    if (job.current.length) file = job.current[0] + (job.current.length > 1 ? '  외 ' + (job.current.length - 1) + '개' : '');
  }
  track.classList.toggle('busy', job.status !== 'copying');
  $('run-phase').textContent = phase;
  $('run-pct').textContent = pct;
  $('run-stats').textContent = stats;
  $('run-file').textContent = file;
  document.title = (pct ? pct + ' — ' : '') + 'G-Copy';
  // Dock / taskbar: a bar while copying, a pulsing one while still counting
  if (native) native.setProgress(job.status === 'copying' && job.workTotal > 0 ? job.workDone / job.workTotal : 2, true);
}

// ── finished ────────────────────────────────────────────────────────────

function fact(label, value, small) {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value, small ? h('small', {}, small) : null));
}

function renderResult(job) {
  const algo = job.options.algo === 'md5' ? 'MD5' : 'xxHash64';
  let tone = 'ok', ico = 'check', title, sub, retry = false;

  if (job.status === 'done') {
    if (job.filesCopied > 0) {
      title = '백업 완료';
      sub = '복사한 파일 ' + num(job.filesCopied) + '개를 대상에서 다시 읽어 확인했고, 모두 원본과 일치합니다 (' + algo + ').';
    } else if (job.filesVerified > 0) {
      title = '검증 완료';
      sub = '대상에 있던 파일 ' + num(job.filesVerified) + '개를 다시 읽어 확인했고, 모두 원본과 일치합니다 (' + algo + ').';
    } else {
      title = '이미 최신입니다';
      sub = '복사할 파일이 없습니다. 파일 ' + num(job.filesSkipped) + '개가 같은 크기와 날짜로 이미 대상에 있습니다.';
    }
  } else if (job.status === 'cancelled') {
    tone = 'warn'; ico = 'stop'; retry = true;
    title = '취소했습니다';
    sub = '검증을 마친 파일 ' + num(job.filesCopied) + '개는 대상에 그대로 있습니다. "다시 실행"을 누르면 남은 파일만 이어서 복사합니다.';
  } else {
    tone = 'bad'; ico = 'alert'; retry = true;
    const short = job.dests.filter((d) => d.failed > 0 || d.stopped);
    const whole = job.dests.filter((d) => d.complete);
    const names = (list) => list.map((d) => baseName(d.path)).join(', ');
    if (job.message) {
      title = '백업을 진행할 수 없습니다';
      sub = job.message;
    } else if (short.length && whole.length) {
      // say which destination is short, and which one is safe
      title = names(short) + '에 파일 ' + num(Math.max(...short.map((d) => d.failed))) + '개를 복사하지 못했습니다';
      sub = names(whole) + '에는 빠진 파일이 없습니다. 아래 원인을 해결한 뒤 "다시 실행"을 누르면 빠진 파일만 다시 복사합니다.';
    } else if (job.filesFailed > 0) {
      title = '파일 ' + num(job.filesFailed) + '개를 백업하지 못했습니다';
      sub = '나머지 파일은 복사와 검증을 마쳤습니다. 아래 원인을 해결한 뒤 "다시 실행"을 누르면 실패한 파일만 다시 복사합니다.';
    } else {
      title = '문제가 ' + num(job.errorCount) + '건 있습니다';
      sub = '복사한 파일은 검증을 마쳤지만, 아래 항목은 확인이 필요합니다.';
    }
  }

  $('result').dataset.tone = tone;
  $('res-icon').setAttribute('href', '#i-' + ico);
  $('res-title').textContent = title;
  $('res-sub').textContent = sub;
  $('btn-retry').hidden = !retry;

  const multi = job.dests.length > 1; // then a file can succeed in one place and fail in another
  $('res-facts').replaceChildren(
    fact(multi ? '복사·검증 (모든 대상)' : '복사·검증', num(job.filesCopied) + '개', fmtBytes(job.bytesCopied)),
    job.filesVerified > 0
      ? fact('재검증', num(job.filesVerified) + '개', '건너뜀 ' + num(job.filesSkipped))
      : fact('건너뜀', num(job.filesSkipped) + '개', '이미 최신'),
    fact(multi ? '실패 (한 곳 이상)' : '실패', num(job.filesFailed) + '개'),
    fact('소요 시간', fmtDur(job.seconds), job.workDone > 0 ? '평균 ' + fmtBytes(job.speed) + '/s' : ''),
  );

  const notes = job.warnings.map((w) => h('li', { class: 'warn' }, w));
  const left = [];
  if (job.excluded > 0) left.push('.DS_Store 같은 시스템 파일 ' + num(job.excluded) + '개');
  if (job.special > 0) left.push('링크·특수 파일 ' + num(job.special) + '개');
  if (left.length) notes.push(h('li', {}, left.join('와 ') + '는 백업에서 제외했습니다.'));
  $('res-notes').replaceChildren(...notes);

  const wrap = $('res-errors-wrap');
  wrap.hidden = job.errors.length === 0;
  $('res-errors-title').textContent = '문제 ' + num(job.errorCount) + '건' +
    (job.errorCount > job.errors.length ? ' (처음 ' + job.errors.length + '건 표시)' : '');
  $('res-errors').replaceChildren(...job.errors.map((e) => h('li', {},
    h('p', { class: 'where' }, [e.path, e.dest].filter(Boolean).join('  →  ')),
    h('p', { class: 'why' }, e.message),
  )));

  document.title = (job.status === 'done' ? '✓ 완료' : job.status === 'cancelled' ? '취소됨' : '⚠ 확인 필요') + ' — G-Copy';
  if (native) {
    native.setProgress(-1, false);
    if (announce !== job.id) return;
    announce = null; // tell the user once, in case the window is in the background
    native.notify('G-Copy — ' + title, sub);
  }
}

// ── job lifecycle ───────────────────────────────────────────────────────

let announce = null; // id of a job seen running in this window: its end is worth a notification

let pollTimer = 0;
function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

function applyJob(job) {
  if (job.status === 'idle') {
    state.job = null;
    if (native) native.setProgress(-1, false);
    if (state.mode !== 'setup') { setMode('setup'); renderSetup(); document.title = 'G-Copy'; }
    return;
  }
  const fresh = !state.job || state.job.id !== job.id || state.mode === 'setup';
  state.job = job;
  const finished = FINISHED.includes(job.status);
  if (fresh) {
    // also covers a page reload in the middle of a run
    state.sources = job.options.sources.map(item);
    state.dests = job.options.destinations.map(item);
    renderLanes();
  }
  setMode(finished ? 'finished' : 'running');
  if (!finished) announce = job.id;
  state.dests.forEach((d, i) => d.extraEl && d.extraEl.replaceChildren(...destExtra(job, i)));
  if (finished) renderResult(job); else renderRun(job);
}

async function poll() {
  try {
    applyJob(await api('/api/job'));
  } catch {
    schedule(1500); // keep trying: the run itself continues in the app
    return;
  }
  if (state.mode === 'running') schedule(400);
}

async function startJob(opts) {
  const err = $('start-err');
  err.hidden = true;
  $('btn-start').disabled = true;
  try {
    const job = await api('/api/job', opts);
    store.set('opts', { algo: opts.algo, subfolder: opts.subfolder, reverify: opts.reverify });
    $('run-fill').style.width = '0%';
    applyJob(job);
    schedule(250);
  } catch (e) {
    if (state.mode !== 'setup') { setMode('setup'); renderSetup(); }
    err.textContent = e.message;
    err.hidden = false;
    $('btn-start').disabled = false;
  }
}

$('btn-start').addEventListener('click', () => startJob(options()));

let cancelArmed = 0;
$('btn-cancel').addEventListener('click', async () => {
  const btn = $('btn-cancel');
  if (!cancelArmed) { // ask once more, without a system dialog
    btn.textContent = '정말 취소할까요?';
    cancelArmed = setTimeout(() => { cancelArmed = 0; btn.textContent = '취소'; }, 3000);
    return;
  }
  clearTimeout(cancelArmed);
  cancelArmed = 0;
  btn.textContent = '취소';
  try { await api('/api/job/cancel', {}); } catch { /* shown by api() */ }
});

$('btn-retry').addEventListener('click', async () => {
  const opts = state.job.options;
  try { await api('/api/job/dismiss', {}); } catch { return; }
  state.job = null;
  await startJob(opts);
});

$('btn-new').addEventListener('click', async () => {
  try { await api('/api/job/dismiss', {}); } catch { return; }
  state.job = null;
  state.sources = [];                       // the next drive…
  state.dests = state.dests.map((d) => item(d.path)); // …to the same place
  setMode('setup');
  document.title = 'G-Copy';
  renderSetup();
  refreshDests();
});

for (const id of ['opt-subfolder', 'opt-reverify', 'opt-algo']) $(id).addEventListener('change', renderSetup);

// ── folder picker ───────────────────────────────────────────────────────

const picker = { kind: 'src', path: '', free: null, volumes: [] };

function volButton(name, meta, path, ico, used) {
  return h('li', {}, h('button', {
    class: 'vol', type: 'button', title: path, 'aria-current': picker.path === path ? 'true' : null,
    onclick: () => browse(path),
  },
    icon(ico),
    h('span', { class: 'vname' }, name),
    meta ? h('span', { class: 'vmeta' }, meta) : null,
    used != null ? (() => { const m = h('span', { class: 'meter' }, h('i')); m.firstChild.style.width = used + '%'; return m; })() : null,
  ));
}

function renderSide() {
  $('vol-list').replaceChildren(...picker.volumes.map((v) => volButton(
    v.name,
    v.total > 0 ? '여유 ' + fmtBytes(v.free) + ' / ' + fmtBytes(v.total) : '',
    v.path,
    v.kind === 'home' ? 'home' : 'disk',
    v.total > 0 ? Math.round((1 - v.free / v.total) * 100) : null,
  )));
  const recent = store.get('recent.' + picker.kind, []);
  $('recent-head').hidden = recent.length === 0;
  $('recent-list').replaceChildren(...recent.map((p) => volButton(baseName(p), p, p, 'folder', null)));
}

// Only the most recent request may update the list: a slow answer for an
// earlier click must not replace what the user asked for afterwards.
let browseSeq = 0;

async function browse(path) {
  const err = $('browse-err');
  const seq = ++browseSeq;
  const input = $('path-input');
  const before = input.value;
  let data;
  try {
    data = await api('/api/browse?path=' + encodeURIComponent(path));
  } catch (e) {
    if (seq !== browseSeq) return false;
    err.textContent = e.message;
    err.hidden = false;
    return false;
  }
  if (seq !== browseSeq) return false;
  err.hidden = true;
  picker.path = data.path;
  picker.free = data.free ?? null;
  // Do not overwrite a path the user started typing while this was loading.
  if (input.value === before || path === input.value.trim()) input.value = data.path;
  $('picker-chosen').textContent = tailPath(data.path);
  $('picker-choose').disabled = false;

  const rows = [];
  if (data.parent) {
    rows.push(h('li', {}, h('button', { class: 'dir up', type: 'button', onclick: () => browse(data.parent) }, icon('up'), h('span', {}, '상위 폴더'))));
  }
  for (const d of data.dirs) {
    rows.push(h('li', {}, h('button', { class: 'dir', type: 'button', onclick: () => browse(d.path) }, icon('folder'), h('span', {}, d.name))));
  }
  if (!data.dirs.length) {
    rows.push(h('li', { class: 'empty' }, '하위 폴더가 없습니다' + (data.files ? ' (파일 ' + num(data.files) + '개)' : '') + '. 이 폴더를 쓰려면 "이 폴더 선택"을 누르세요.'));
  }
  $('dir-list').replaceChildren(...rows);
  $('dir-list').scrollTop = 0;
  renderSide();
  return true;
}

async function openPicker(kind) {
  picker.kind = kind;
  picker.path = '';
  $('picker-title').textContent = kind === 'src' ? '원본 선택' : '대상 선택';
  $('btn-mkdir').hidden = kind !== 'dst';
  $('mkdir-form').hidden = true;
  $('browse-err').hidden = true;
  $('picker-choose').disabled = true;
  $('picker-chosen').textContent = '';
  $('dir-list').replaceChildren();
  $('picker').showModal();
  const seq = ++browseSeq; // forget answers still on their way from last time
  try {
    picker.volumes = state.volumes = (await api('/api/volumes')).volumes;
  } catch { return; }
  renderSide();
  if (seq !== browseSeq) return; // the user already went somewhere
  const start = picker.volumes.find((v) => v.kind === 'external') || picker.volumes.find((v) => v.kind === 'home') || picker.volumes[0];
  if (start) await browse(start.path);
}

$('add-src').addEventListener('click', () => openPicker('src'));
$('add-dst').addEventListener('click', () => openPicker('dst'));

$('path-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = $('path-input').value.trim();
  if (p) browse(p);
});

$('btn-mkdir').addEventListener('click', () => {
  $('mkdir-form').hidden = false;
  $('mkdir-input').value = '';
  $('mkdir-input').focus();
});
$('mkdir-cancel').addEventListener('click', () => { $('mkdir-form').hidden = true; });
$('mkdir-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('browse-err');
  try {
    const made = await api('/api/mkdir', { parent: picker.path, name: $('mkdir-input').value });
    $('mkdir-form').hidden = true;
    await browse(made.path);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function addFolder(kind, path, free) {
  const list = kind === 'src' ? state.sources : state.dests;
  if (!list.some((x) => x.path === path)) list.push({ ...item(path), free });
  const key = 'recent.' + kind;
  store.set(key, [path, ...store.get(key, []).filter((p) => p !== path)].slice(0, 6));
  saveDests();
  renderSetup();
}

$('picker-choose').addEventListener('click', () => {
  if (!picker.path) return;
  addFolder(picker.kind, picker.path, picker.free);
  $('picker').close();
});

// ── desktop app only: the system's folder dialog, and dropped folders ───

// addPaths checks each path with the engine first, so a dropped file (or a
// disk that just went away) is explained instead of silently added.
async function addPaths(kind, paths) {
  const err = $('start-err');
  const problems = [];
  for (const p of paths) {
    try {
      const info = await api('/api/browse?path=' + encodeURIComponent(p));
      addFolder(kind, info.path, info.free ?? null);
    } catch (e) {
      problems.push(/찾을 수 없습니다/.test(e.message) ? '폴더만 추가할 수 있습니다: ' + p : e.message);
    }
  }
  if (problems.length) {
    err.textContent = problems.join('  ·  ');
    err.hidden = false;
  }
}

if (native) {
  const btn = $('btn-native');
  btn.textContent = native.platform === 'darwin' ? 'Finder에서 선택…' : native.platform === 'win32' ? '탐색기에서 선택…' : '파일 관리자에서 선택…';
  btn.addEventListener('click', async () => {
    const kind = picker.kind;
    const chosen = await native.pickFolder(kind, picker.path);
    if (!chosen) return; // dialog cancelled
    $('picker').close();
    await addPaths(kind, [chosen]);
  });

  for (const [id, kind] of [['lane-src', 'src'], ['lane-dst', 'dst']]) {
    const lane = $(id);
    const droppable = (e) => state.mode === 'setup' && [...e.dataTransfer.types].includes('Files');
    lane.addEventListener('dragover', (e) => {
      if (!droppable(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop');
    });
    lane.addEventListener('dragleave', (e) => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('drop'); });
    lane.addEventListener('drop', async (e) => {
      lane.classList.remove('drop');
      if (!droppable(e)) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => native.pathForFile(f)).filter(Boolean);
      if (paths.length) await addPaths(kind, paths);
    });
  }
  // A folder dropped anywhere else must not make the window navigate to it.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => { if (!e.defaultPrevented) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; } });
  }
}

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}
for (const dlg of document.querySelectorAll('dialog')) {
  // Close on a click on the backdrop, but not when a text selection that
  // started inside the dialog merely ends out there.
  let pressedOutside = false;
  dlg.addEventListener('mousedown', (e) => { pressedOutside = e.target === dlg; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && pressedOutside) dlg.close(); });
}

// ── history ─────────────────────────────────────────────────────────────

$('btn-history').addEventListener('click', async () => {
  const list = $('hist-list');
  list.replaceChildren();
  $('history').showModal();
  let items;
  try { items = (await api('/api/history')).history; } catch { return; }
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'empty' }, '아직 기록이 없습니다. 백업을 마치면 여기에 남습니다.'));
    return;
  }
  const df = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  list.replaceChildren(...items.map((j) => {
    const tone = j.status === 'done' ? 'ok' : j.status === 'cancelled' ? 'warn' : 'bad';
    const ico = icon(j.status === 'done' ? 'check' : j.status === 'cancelled' ? 'stop' : 'alert');
    ico.classList.add(tone);
    const what = j.options.sources.map(baseName).join(', ') + '  →  ' + j.options.destinations.map(baseName).join(', ');
    let detail = '복사 ' + num(j.filesCopied) + '개 · ' + fmtBytes(j.bytesCopied) + ' · 건너뜀 ' + num(j.filesSkipped) + ' · ' + fmtDur(j.seconds);
    if (j.status === 'cancelled') detail = '취소됨 · ' + detail;
    if (j.status === 'failed') detail = (j.message || '실패 ' + num(j.filesFailed) + '개 · 문제 ' + num(j.errorCount) + '건') + (j.message ? '' : ' · ' + detail);
    return h('li', {}, ico, h('span', { class: 'what', title: what }, what), h('span', { class: 'when' }, df.format(new Date(j.startedAt))), h('span', { class: 'detail' }, detail));
  }));
});

// ── start-up ────────────────────────────────────────────────────────────

// refreshDests re-reads free space and drops destinations that are no
// longer connected.
async function refreshDests() {
  const free = new Map(), gone = new Set();
  for (const d of [...state.dests]) {
    try {
      free.set(d.path, (await api('/api/browse?path=' + encodeURIComponent(d.path))).free ?? null);
    } catch { gone.add(d.path); /* not mounted today */ }
  }
  if (state.mode !== 'setup') return;
  // Apply to the list as it is now: the user may have changed it meanwhile.
  state.dests = state.dests.filter((d) => !gone.has(d.path));
  for (const d of state.dests) if (free.has(d.path)) d.free = free.get(d.path);
  renderSetup();
}

(async function init() {
  await store.load();
  const o = store.get('opts', null);
  if (o) {
    $('opt-algo').value = o.algo === 'md5' ? 'md5' : 'xxh64';
    $('opt-subfolder').checked = o.subfolder !== false;
    $('opt-reverify').checked = !!o.reverify;
  }
  renderSetup();
  let job;
  try {
    state.volumes = (await api('/api/volumes')).volumes;
    job = await api('/api/job');
  } catch { schedule(1500); return; }
  if (job.status !== 'idle') {
    applyJob(job);
    if (state.mode === 'running') schedule(400);
    return;
  }
  // Remember where backups went last time: the NAS path rarely changes.
  state.dests = store.get('dests', []).map(item);
  refreshDests();
})();
