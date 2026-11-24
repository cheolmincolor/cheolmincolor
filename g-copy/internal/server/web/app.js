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

const nf = new Intl.NumberFormat('en-US');
const num = (n) => nf.format(n || 0);
// plural(3, 'file') → "3 files"; plural(2, 'copy', 'copies') → "2 copies"
const plural = (n, word, many) => num(n) + ' ' + (n === 1 ? word : many || word + 's');

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
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

// The remaining time, rounded so it does not pretend to be exact, and the
// estimated clock time of the finish (which only moves when the estimate
// really changes; see the engine's estimator).
function fmtLeft(job) {
  if (!job.finishAt || !(job.eta > 0)) return 'estimating time left…';
  const m = Math.round(job.eta / 60);
  const left = job.eta < 50 ? 'less than a minute' : m < 60 ? 'about ' + m + ' min' : 'about ' + Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  const end = new Date(job.finishAt);
  return left + ' left · done around ' + String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0');
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
    block('Lost the connection to G-Copy. Check that the app is running — this screen comes back by itself when it reconnects.');
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    block(data.error || 'Session expired.');
    throw new Error('unauthorized');
  }
  unblock();
  if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ')');
  return data;
}

// ── state ───────────────────────────────────────────────────────────────

const state = {
  queue: [],       // backups waiting for the running one (see /api/queue)
  detached: false, // the person left a running backup on its own to set up another
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

// "Also re-check…" as the person set it. While verification is off the box
// is shown empty and disabled; their choice comes back with verification.
let recheckWanted = false;
const wantRecheck = () => ($('opt-verify').checked ? $('opt-reverify').checked : recheckWanted);

function options() {
  return {
    sources: state.sources.map((s) => s.path),
    destinations: state.dests.map((d) => d.path),
    algo: 'xxh64',
    noVerify: !$('opt-verify').checked,
    subfolder: $('opt-subfolder').checked,
    reverify: $('opt-verify').checked && wantRecheck(),
    mirror: $('opt-mirror').checked,
  };
}

// ── lanes ───────────────────────────────────────────────────────────────

// ring: a circular gauge. While setting up it shows how full the disk is;
// while copying, that destination's own progress.
const RING_R = 22, RING_LEN = 2 * Math.PI * RING_R;
function ringEl() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  for (const cls of ['track', 'arc']) {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '26'); c.setAttribute('cy', '26'); c.setAttribute('r', String(RING_R));
    if (cls === 'arc') { c.setAttribute('stroke-dasharray', String(RING_LEN)); c.setAttribute('stroke-dashoffset', String(RING_LEN)); }
    svg.append(c);
  }
  return h('span', { class: 'ring', 'data-state': 'cap' }, svg, h('span', { class: 'ring-c' }));
}

// setRing(d, fraction 0..1, state, centre: text or icon name)
function setRing(d, frac, state, centre) {
  const r = d.ringEl;
  if (!r) return;
  r.dataset.state = state;
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  r.querySelector('.arc').setAttribute('stroke-dashoffset', String(RING_LEN * (1 - f)));
  const c = r.querySelector('.ring-c');
  const key = state + '|' + centre;
  if (c.dataset.key === key) return;
  c.dataset.key = key;
  c.replaceChildren(centre && centre.startsWith('#') ? icon(centre.slice(1)) : (centre || ''));
}

function card(item, kind, index) {
  const extra = h('div', { class: 'extra' });
  const cap = h('div', { class: 'cap', hidden: true });
  item.extraEl = extra;
  item.capEl = cap;
  let lead;
  if (kind === 'dst') {
    lead = item.ringEl = ringEl();
    const used = item.total > 0 ? 1 - item.free / item.total : 0;
    setRing(item, used, 'cap', '#' + (item.isVolume ? 'disk' : 'folder'));
  } else {
    lead = h('span', { class: 'glyph' }, icon(item.isVolume ? 'disk' : 'folder'));
  }
  return item.cardEl = h('li', { class: 'card' },
    lead,
    h('span', { class: 'name', title: item.path }, baseName(item.path)),
    h('span', { class: 'path', title: item.path }, tailPath(item.path)),
    h('button', {
      class: 'iconbtn', type: 'button', 'aria-label': 'Remove ' + baseName(item.path),
      onclick: () => { (kind === 'src' ? state.sources : state.dests).splice(index, 1); saveDests(); renderSetup(); },
    }, icon('x')),
    cap,
    extra,
  );
}

function saveDests() { store.set('dests', state.dests.map((d) => d.path)); }

function renderLanes() {
  $('src-list').replaceChildren(...state.sources.map((s, i) => card(s, 'src', i)));
  $('dst-list').replaceChildren(...state.dests.map((d, i) => card(d, 'dst', i)));
  drawFlow();
}

// ── flow lines from each source to each destination ────────────────────

let flowState = []; // per destination: '', 'live', 'ok' or 'bad'

function drawFlow() {
  const svg = $('flow-lines');
  const stage = $('stage').getBoundingClientRect();
  const srcs = [...$('src-list').children], dsts = [...$('dst-list').children];
  if (!srcs.length || !dsts.length || getComputedStyle(svg).display === 'none') { svg.replaceChildren(); return; }
  const parts = [];
  const x1 = srcs[0].getBoundingClientRect().right - stage.left;
  const x2 = dsts[0].getBoundingClientRect().left - stage.left;
  const mid = (x1 + x2) / 2;
  // all sources meet at one point, then fan out to the destinations
  const ys = srcs.map((el) => { const r = el.getBoundingClientRect(); return r.top + Math.min(r.height / 2, 40) - stage.top; });
  const hubY = ys.reduce((a, b) => a + b, 0) / ys.length;
  for (const y of ys) parts.push(['M', x1, y, 'C', mid - 10, y, mid - 30, hubY, mid, hubY].join(' '));
  const out = dsts.map((el, i) => {
    const r = el.getBoundingClientRect();
    const y = r.top + Math.min(r.height / 2, 40) - stage.top;
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ['M', mid, hubY, 'C', mid + 30, hubY, mid + 10, y, x2, y].join(' '));
    if (flowState[i]) p.setAttribute('class', flowState[i]);
    return p;
  });
  const live = flowState.some((x) => x === 'live');
  const allOk = flowState.length === dsts.length && flowState.every((x) => x === 'ok');
  const ins = parts.map((d) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    if (live || allOk) p.setAttribute('class', live ? 'live' : 'ok');
    return p;
  });
  const hub = document.createElementNS(SVG, 'circle');
  hub.setAttribute('cx', String(mid)); hub.setAttribute('cy', String(hubY)); hub.setAttribute('r', '3.5');
  svg.replaceChildren(...ins, ...out, hub);
}

new ResizeObserver(() => drawFlow()).observe($('stage'));

// The rings and lines follow the job.
function renderDestProgress(job) {
  const finished = FINISHED.includes(job.status);
  const unverified = !!job.options.noVerify;
  flowState = state.dests.map((d, i) => {
    const s = job.dests[i];
    if (!s) return '';
    if (d.cardEl) d.cardEl.classList.toggle('failed', finished && job.status === 'failed' && !s.complete);
    if (finished) {
      // copied but not verified: complete, yet never shown with the "verified" tick
      if (s.complete && (s.unverified > 0 || (unverified && s.copied > 0))) { setRing(d, 1, 'warn', '#alert'); return ''; }
      if (s.complete) { setRing(d, 1, 'ok', '#check'); return 'ok'; }
      if (job.status === 'cancelled') { setRing(d, s.workTotal ? s.workDone / s.workTotal : 0, 'warn', '#stop'); return ''; }
      setRing(d, s.workTotal ? s.workDone / s.workTotal : 0, 'bad', '#alert');
      return 'bad';
    }
    if (job.status !== 'copying') { setRing(d, 0.25, 'wait', ''); return ''; }
    if (job.paused && s.workTotal && s.workDone < s.workTotal) { setRing(d, s.workDone / s.workTotal, 'cap', '#pause'); return ''; }
    if (!s.workTotal) { setRing(d, 1, s.unverified > 0 ? 'warn' : 'ok', s.unverified > 0 ? '#alert' : '#check'); return s.unverified > 0 ? '' : 'ok'; } // nothing to copy here
    const f = s.workDone / s.workTotal;
    setRing(d, f, s.stopped ? 'bad' : 'run', s.stopped ? '#alert' : Math.floor(f * 100) + '%');
    return s.stopped ? 'bad' : f >= 1 ? 'ok' : 'live';
  });
  drawFlow();
}

function renderSetup() {
  flowState = []; // plain lines until something runs
  renderLanes();
  const need = sourceNeed();
  for (const s of state.sources) {
    const e = sizes.get(s.path);
    s.capEl.hidden = true;
    s.extraEl.replaceChildren(...(!e || e.pending ? [h('span', {}, 'Checking size…')] : e.failed ? [] : [h('span', {}, plural(e.files, 'file') + ' · ' + fmtBytes(e.bytes))]));
  }
  for (const d of state.dests) {
    d.capEl.hidden = true;
    if (d.free == null) continue;
    const kids = [h('span', {}, fmtBytes(d.free) + ' free' + (d.total > 0 ? ' of ' + fmtBytes(d.total) : ''))];
    if (need.checking) kids.push(h('span', {}, 'Checking size…'));
    else if (need.known && need.bytes > d.free) kids.push(h('span', { class: 'space', title: 'The source holds ' + fmtBytes(need.bytes) + '. Files already on this destination are not copied again, so it may still fit.' }, icon('alert'), 'Not enough space for this source'));
    d.extraEl.replaceChildren(...kids);
  }
  const verify = $('opt-verify').checked;
  $('verify-warn').hidden = verify;
  $('tagline').textContent = verify ? 'Copy · Verify · Copies only what is new' : 'Copy · Copies only what is new';
  const rv = $('opt-reverify');
  if (!verify && !rv.disabled) { recheckWanted = rv.checked; rv.checked = false; }
  if (verify && rv.disabled) rv.checked = recheckWanted;
  rv.disabled = !verify;
  $('reverify-why').hidden = verify;

  const many = state.sources.length > 1;
  const sub = $('opt-subfolder');
  if (many) sub.checked = true;
  sub.disabled = many;

  const ready = state.sources.length > 0 && state.dests.length > 0;
  // While another backup runs, a new one waits its turn in the queue.
  $('btn-start').textContent = state.editing ? 'Save Changes' : otherRunning() ? 'Add to Queue' : 'Start Backup';
  const editing = state.editing && (state.queue || []).find((x) => x.id === state.editing);
  $('edit-note').hidden = !editing;
  $('edit-note').textContent = editing ? 'Editing queued backup ' + ((state.queue || []).indexOf(editing) + 1) + ' (' + editing.name + '). Change the folders or options, then Save Changes.' : '';
  $('btn-edit-cancel').hidden = !editing;
  $('btn-save-sched').hidden = !!editing;
  $('btn-start').disabled = !ready;
  $('btn-save-sched').disabled = !ready;
  $('start-err').hidden = true;

  let hint = '';
  if (!state.sources.length) hint = 'Add a source';
  else if (!state.dests.length) hint = 'Add a destination';
  else {
    const d = state.dests[0].path;
    const first = sub.checked ? joinPath(d, baseName(state.sources[0].path)) : d;
    const more = state.sources.length * state.dests.length - 1;
    hint = 'Copies to:  ' + first + (more > 0 ? '  and ' + more + ' more' : '');
  }
  $('hint').textContent = hint;
  $('mirror-hint').hidden = !$('opt-mirror').checked;
}

// ── how big the sources are, to warn about a destination that is too small ──

const sizes = new Map(); // source path → { bytes } | { pending } | { failed }

function sourceNeed() {
  let bytes = 0, checking = false, known = state.sources.length > 0;
  for (const s of state.sources) {
    let e = sizes.get(s.path);
    if (!e) {
      e = { pending: true };
      sizes.set(s.path, e);
      const path = s.path;
      api('/api/size?path=' + encodeURIComponent(path))
        .then((r) => sizes.set(path, { bytes: r.bytes, files: r.files }), () => sizes.set(path, { failed: true }))
        .then(() => { if (state.mode === 'setup') renderSetup(); });
    }
    if (e.pending) checking = true;
    else if (e.failed) known = false;
    else bytes += e.bytes;
  }
  return { bytes, checking, known: known && !checking };
}

// ── sizes, once the source has been read and compared ─────────────────

function capBar(parts) { // [class, bytes, key label]
  const total = parts.reduce((n, p) => n + Math.max(0, p[1]), 0) || 1;
  const bar = h('div', { class: 'capbar', role: 'img', 'aria-label': parts.map((p) => p[2] + ' ' + fmtBytes(p[1])).join(', ') });
  for (const [cls, bytes] of parts) { const seg = h('i', { class: cls }); seg.style.width = (Math.max(0, bytes) / total) * 100 + '%'; if (bytes > 0) seg.style.minWidth = '3px'; bar.append(seg); } // a small share still shows
  const colour = { used: '#5E5E5E', copy: '#E0E0E0', have: '#777777', free: '#303030', over: '#C6C6C6' };
  const key = h('div', { class: 'cap-key' }, ...parts.filter((p) => p[1] > 0).map((p) => { const k = h('span', {}, p[2]); k.style.setProperty('--k', colour[p[0]]); return k; }));
  return [bar, key];
}

function renderSizes(job) {
  const known = job.sources && job.sources.length > 0;
  state.sources.forEach((s, i) => {
    const st = known && job.sources[i];
    s.capEl.hidden = !st;
    if (!st) { if (s.extraEl) s.extraEl.replaceChildren(); return; }
    s.extraEl.replaceChildren();
    const have = st.bytes - st.copyBytes;
    s.capEl.replaceChildren(
      h('div', { class: 'cap-text' },
        h('span', {}, h('b', {}, plural(st.files, 'file') + ' · ' + fmtBytes(st.bytes)), ' in this source'),
        h('span', {}, st.copyFiles > 0 ? plural(st.copyFiles, 'file') + ' · ' + fmtBytes(st.copyBytes) + ' to copy' : 'nothing new to copy')),
      ...capBar([['copy', st.copyBytes, 'To copy'], ['have', have, 'Already on the destination']]),
    );
  });
  state.dests.forEach((d, i) => {
    const st = job.dests[i];
    const show = known && st && st.total > 0 && st.free >= 0;
    d.capEl.hidden = !show;
    if (!show) return;
    const used = Math.max(0, st.total - st.free);
    const after = st.free - st.need;
    const short = after < 0;
    d.capEl.replaceChildren(
      h('div', { class: 'cap-text' },
        h('span', {}, 'This backup ', h('b', {}, fmtBytes(st.need))),
        h('span', {}, 'Free before ', h('b', {}, fmtBytes(st.free))),
        short ? h('span', { class: 'short' }, icon('alert'), 'Short by ' + fmtBytes(-after))
          : h('span', {}, 'Free after ', h('b', {}, fmtBytes(after)))),
      ...capBar(short ? [['used', used, 'Used'], ['over', st.free, 'Not enough room for ' + fmtBytes(st.need)]]
        : [['used', used, 'Used'], ['copy', st.need, 'This backup'], ['free', after, 'Free after']]),
    );
  });
}

function destExtra(job, i) {
  const d = job.dests[i];
  const out = [];
  if (!d) return out;
  const finished = FINISHED.includes(job.status);
  if (job.status === 'scanning' || job.status === 'comparing') return [h('span', {}, 'Waiting')];
  if (job.status === 'confirming') {
    return [d.toRemove > 0
      ? h('span', { class: 'warnc' }, plural(d.toRemove, 'file') + ' to clean up · ' + fmtBytes(d.toRemoveBytes))
      : h('span', {}, 'Nothing to clean up')];
  }
  const copiedText = job.options.noVerify ? ' copied, not verified' : ' copied & verified';
  if (d.complete && job.options.noVerify && d.copied > 0) {
    out.push(h('span', { class: 'unverified' }, plural(d.copied, 'file') + copiedText));
  } else if (d.complete && d.unverified > 0) {
    out.push(h('span', { class: 'unverified' }, d.copied > 0 ? plural(d.copied, 'file') + copiedText : 'Nothing new to copy'));
  } else if (d.complete) {
    out.push(h('span', { class: 'ok' }, d.copied > 0 ? '✓ ' + plural(d.copied, 'file') + copiedText : d.reverified > 0 ? '✓ ' + plural(d.reverified, 'file') + ' re-checked' : '✓ Up to date'));
  } else {
    out.push(h('span', {}, plural(d.copied, 'file') + copiedText));
  }
  if (d.copied > 0 && d.reverified > 0) out.push(h('span', {}, num(d.reverified) + ' re-checked'));
  if (d.unverified > 0 && !(job.options.noVerify && d.unverified === d.copied)) out.push(h('span', { class: 'unverified' }, plural(d.unverified, 'file') + (d.unverified === 1 ? ' was' : ' were') + ' copied without verification'));
  if (d.skipped > 0) out.push(h('span', {}, num(d.skipped) + ' skipped'));
  if (d.replaced > 0) out.push(h('span', {}, num(d.replaced) + ' replaced'));
  if (d.datesFixed > 0) out.push(h('span', {}, num(d.datesFixed) + ' dates fixed'));
  if (d.failed > 0) out.push(h('span', { class: 'bad' }, num(d.failed) + ' failed'));
  if (d.stopped) out.push(h('span', { class: 'bad' }, 'Stopped'));
  if (d.removed > 0) out.push(h('span', {}, num(d.removed) + ' cleaned up'));
  else if (job.mirror === 'approved' && d.toRemove > 0 && !finished) out.push(h('span', {}, num(d.toRemove) + ' to clean up'));
  if (finished) {
    out.push(h('button', { class: 'link', type: 'button', onclick: () => reveal(d) }, 'Show in Finder'));
    for (const r of d.reports) out.push(h('span', { class: 'report', title: r }, 'Report: ' + baseName(r)));
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
  const scanned = plural(job.scanFiles, 'file') + ' · ' + fmtBytes(job.scanBytes);
  let phase, pct = '', stats, file = '';

  if (job.status === 'scanning') {
    phase = 'Reading the source'; stats = scanned;
  } else if (job.status === 'comparing') {
    phase = 'Comparing with the destinations'; stats = scanned;
  } else {
    phase = job.options.noVerify ? 'Copying (not verifying)' : 'Copying and verifying';
    const p = job.workTotal > 0 ? Math.min(99, Math.floor((job.workDone / job.workTotal) * 100)) : 0;
    pct = p + '%';
    $('run-fill').style.width = (job.workTotal > 0 ? (job.workDone / job.workTotal) * 100 : 0) + '%';
    const parts = [fmtBytes(job.speed) + '/s'];
    parts.push(fmtLeft(job));
    parts.push(num(job.filesCopied) + ' copied');
    if (job.filesSkipped) parts.push(num(job.filesSkipped) + ' skipped');
    if (job.filesVerified) parts.push(num(job.filesVerified) + ' re-checked');
    if (job.filesFailed) parts.push(num(job.filesFailed) + ' failed');
    stats = parts.join(' · ');
    if (job.current.length) file = job.current[0] + (job.current.length > 1 ? '  and ' + (job.current.length - 1) + ' more' : '');
  }
  if (job.paused) { phase = 'Paused'; stats = 'Paused — nothing is being read or written. ' + num(job.filesCopied) + ' copied so far.'; file = ''; }
  track.classList.toggle('busy', job.status !== 'copying');
  track.classList.toggle('paused', !!job.paused);
  $('btn-pause').hidden = job.status !== 'copying';
  $('pause-text').textContent = job.paused ? 'Resume' : 'Pause';
  $('pause-icon').setAttribute('href', job.paused ? '#i-play' : '#i-pause');
  $('btn-pause').classList.toggle('primary', !!job.paused);
  $('btn-pause').classList.toggle('ghost', !job.paused);
  const order = ['scanning', 'comparing', 'copying', 'report'];
  const at = order.indexOf(job.status);
  for (const li of $('run-steps').children) {
    const k = order.indexOf(li.dataset.step);
    li.className = k < at ? 'done' : k === at ? 'now' : '';
  }
  $('step-copy').textContent = job.options.noVerify ? 'Copy' : 'Copy & verify';
  $('run-phase').textContent = phase;
  $('run-pct').textContent = pct;
  $('run-stats').textContent = stats;
  $('run-file').textContent = file;
  document.title = (job.paused ? 'Paused — ' : pct ? pct + ' — ' : '') + 'G-Copy';
  // Dock / taskbar: a bar while copying, a pulsing one while still counting.
  // Paused: the Mac may sleep.
  if (native) native.setProgress(job.status === 'copying' && job.workTotal > 0 ? job.workDone / job.workTotal : 2, true, !!job.paused);
}

// ── finished ────────────────────────────────────────────────────────────

function fact(label, value, small, under) {
  return h('div', {}, h('dt', {}, label, under ? h('small', {}, under) : null), h('dd', {}, value, small ? ' ' : null, small ? h('small', {}, small) : null));
}

function renderResult(job) {
  const algo = job.options.algo === 'md5' ? 'MD5' : 'xxHash64';
  const unverified = !!job.options.noVerify;
  let tone = 'ok', ico = 'check', title, sub, retry = false;

  if (job.status === 'done') {
    if (job.filesCopied > 0 && unverified) {
      tone = 'warn'; ico = 'alert';
      title = 'Copied, not verified';
      sub = plural(job.filesCopied, 'file') + (job.filesCopied === 1 ? ' was' : ' were') + ' copied. Verification was turned off, so the copies were not read back and compared with the source. To check them, turn verification on and run this backup again: it checks them by itself.';
    } else if (job.filesCopied > 0) {
      title = 'Backup complete';
      sub = 'All ' + plural(job.filesCopied, 'copied file') + ' were read back from the destination and match the source (' + algo + ').';
    } else if (job.filesVerified > 0) {
      title = 'Verification complete';
      sub = 'All ' + plural(job.filesVerified, 'file') + ' already on the destination were read back and match the source (' + algo + ').';
    } else if (job.dests.some((d) => d.unverified > 0)) {
      const n = Math.max(...job.dests.map((d) => d.unverified));
      tone = 'warn'; ico = 'alert';
      title = 'Up to date, but not verified';
      sub = 'Nothing needed copying. ' + plural(n, 'file') + ' on the destination ' + (n === 1 ? 'was' : 'were') + ' copied earlier without verification and ' + (n === 1 ? 'has' : 'have') + ' not been checked since. Turn verification on and run this backup again: it checks them by itself.';
    } else if (job.dests.some((d) => d.removed > 0)) {
      title = 'Sync complete';
      sub = 'Nothing needed copying; files no longer in the source were cleaned up on the destination.';
    } else {
      title = 'Already up to date';
      sub = 'Nothing to copy: ' + plural(job.filesSkipped, 'file') + ' are already on the destination with the same size and date.';
    }
  } else if (job.status === 'cancelled') {
    tone = 'warn'; ico = 'stop'; retry = true;
    title = 'Cancelled';
    sub = plural(job.filesCopied, unverified ? 'copied file' : 'verified file') + ' stay on the destination. "Run Again" copies only the rest.';
  } else {
    tone = 'bad'; ico = 'alert'; retry = true;
    const short = job.dests.filter((d) => d.failed > 0 || d.stopped);
    const whole = job.dests.filter((d) => d.complete);
    const names = (list) => list.map((d) => baseName(d.path)).join(', ');
    if (job.message) {
      title = 'The backup could not run';
      sub = job.message;
    } else if (short.length && whole.length) {
      // say which destination is short, and which one is safe
      title = plural(Math.max(...short.map((d) => d.failed)), 'file') + ' could not be copied to ' + names(short);
      sub = names(whole) + ' has every file. Fix the problem below, then "Run Again" copies only the missing files.';
    } else if (job.filesFailed > 0) {
      title = plural(job.filesFailed, 'file') + ' could not be backed up';
      sub = 'Everything else was copied' + (unverified ? ' (not verified)' : ' and verified') + '. Fix the problem below, then "Run Again" copies only the failed files.';
    } else {
      title = plural(job.errorCount, 'problem') + ' to check';
      sub = (unverified ? 'The files were copied (not verified)' : 'The copied files are verified') + ', but the items below need a look.';
    }
  }

  $('result').dataset.tone = tone;
  $('res-icon').setAttribute('href', '#i-' + ico);
  $('res-title').textContent = title;
  $('res-sub').textContent = sub;
  $('btn-retry').hidden = !retry;
  // The bright button is the one the text recommends: after a failure or a
  // cancel that is "Run Again" ("New Backup" clears the source list).
  $('btn-retry').classList.toggle('primary', retry);
  $('btn-retry').classList.toggle('ghost', !retry);
  $('btn-new').classList.toggle('primary', !retry);
  $('btn-new').classList.toggle('ghost', retry);
  // A run that never started (not enough space, a missing folder) has no figures.
  if (job.status === 'failed' && job.message) $('result').dataset.norun = ''; else delete $('result').dataset.norun;

  const multi = job.dests.length > 1; // then a file can succeed in one place and fail in another
  const failedOn = job.dests.filter((d) => d.failed > 0 || d.stopped).map((d) => baseName(d.path)).join(', ');
  $('res-facts').replaceChildren(
    fact(unverified ? 'Copied, not verified' : 'Copied & verified', num(job.filesCopied), fmtBytes(job.bytesCopied), multi ? 'on every destination' : ''),
    job.filesVerified > 0
      ? fact('Re-checked', num(job.filesVerified), num(job.filesSkipped) + ' skipped')
      : fact('Skipped', num(job.filesSkipped), 'already up to date'),
    fact('Failed', num(job.filesFailed), '', multi && failedOn ? 'on ' + failedOn : ''),
    fact('Time', fmtDur(job.seconds), job.workDone > 0 ? 'avg ' + fmtBytes(job.speed) + '/s' : ''),
  );

  const notes = job.warnings.map((w) => h('li', { class: 'warn' }, w));
  const removed = job.dests.reduce((n, d) => n + d.removed, 0);
  const listed = job.dests.reduce((n, d) => n + d.toRemove, 0);
  if (job.mirror === 'approved' && removed > 0) notes.push(h('li', {}, 'Sync: ' + plural(removed, 'file') + ' no longer in the source were moved (not deleted) to each destination\'s _G-Copy_Removed folder.'));
  if (job.mirror === 'declined') notes.push(h('li', {}, 'Sync: ' + plural(listed, 'file') + ' no longer in the source were left where they are.'));
  if (job.options.label) notes.unshift(h('li', {}, (job.options.queued ? 'Started from the queue: ' : 'Scheduled run: ') + job.options.label));
  if (unverified && job.filesCopied > 0) notes.unshift(h('li', { class: 'warn' }, 'Verification was off: no checksum report (MHL) was written for the files copied in this run.'));
  if (job.datesFixed > 0) notes.push(h('li', {}, plural(job.datesFixed, 'file') + ' had the same size but a different date on the destination. Their content was read back and matches the source, so only the date was corrected — nothing was copied again.'));
  if (job.retried > 0) notes.push(h('li', {}, plural(job.retried, 'copy', 'copies') + ' needed a second try after a temporary problem (a read error or a checksum mismatch).' + (unverified ? '' : ' Every file listed as copied was verified on its final try.')));
  if (job.mirror === 'nothing') notes.push(h('li', {}, 'Sync: the destinations had nothing that is not in the source.'));
  const left = [];
  if (job.excluded > 0) left.push(plural(job.excluded, 'system file') + ' such as .DS_Store');
  if (job.special > 0) left.push(plural(job.special, 'link or special file'));
  if (left.length) notes.push(h('li', {}, 'Left out of the backup: ' + left.join(' and ') + '.'));
  $('res-notes').replaceChildren(...notes);

  const wrap = $('res-errors-wrap');
  wrap.hidden = job.errors.length === 0;
  $('res-errors-title').textContent = plural(job.errorCount, 'problem') +
    (job.errorCount > job.errors.length ? ' (first ' + job.errors.length + ' shown)' : '');
  $('res-errors').replaceChildren(...job.errors.map((e) => h('li', {},
    h('p', { class: 'why' }, e.message),
    h('p', { class: 'where' }, [e.path, e.dest].filter(Boolean).join('  →  ')),
  )));

  document.title = (job.status === 'done' ? (tone === 'warn' ? 'Not verified' : '✓ Done') : job.status === 'cancelled' ? 'Cancelled' : '⚠ Check needed') + ' — G-Copy';
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
  setMode(finished ? 'finished' : job.status === 'confirming' ? 'confirm' : 'running');
  if (!finished) announce = job.id;
  renderSizes(job);
  state.dests.forEach((d, i) => d.extraEl && d.extraEl.replaceChildren(...destExtra(job, i)));
  renderDestProgress(job);
  if (finished) renderResult(job);
  else if (job.status === 'confirming') renderConfirm(job);
  else renderRun(job);
}

// ── sync: show what would be moved, and ask ─────────────────────────────

let confirmShown = null; // job id: the list is built once, so scrolling it is not reset

function renderConfirm(job) {
  if (confirmShown === job.id) return;
  confirmShown = job.id;
  const total = job.dests.reduce((n, d) => n + d.toRemove, 0);
  const bytes = job.dests.reduce((n, d) => n + d.toRemoveBytes, 0);
  $('cf-title').textContent = 'The destinations have ' + plural(total, 'file') + ' that are not in the source';
  $('cf-sub').textContent = '"Move and Continue" moves these files (' + fmtBytes(bytes) + ') to each destination\'s ' +
    '_G-Copy_Removed folder after the backup. Nothing is deleted, so you can get them back.';
  $('cf-dests').replaceChildren(...job.dests.map((d) => h('section', { class: 'cf-dest' },
    h('header', {}, h('strong', { title: d.path }, baseName(d.path)),
      h('span', {}, d.toRemove > 0 ? plural(d.toRemove, 'file') + ' · ' + fmtBytes(d.toRemoveBytes) : 'none')),
    d.toRemove > 0
      ? h('ul', {}, ...d.removeList.map((p) => h('li', {}, p)),
        d.toRemove > d.removeList.length ? h('li', { class: 'more' }, 'and ' + num(d.toRemove - d.removeList.length) + ' more') : null)
      : h('p', { class: 'none' }, 'Nothing to clean up on this destination.'),
  )));
  for (const b of ['cf-move', 'cf-keep', 'cf-cancel']) $(b).disabled = false;
  document.title = 'Check needed — G-Copy';
  if (native) {
    native.setProgress(-1, true);
    native.notify('G-Copy — Your decision is needed', 'Choose whether to clean up ' + plural(total, 'file') + ' that are no longer in the source.');
  }
}

async function answerConfirm(remove) {
  for (const b of ['cf-move', 'cf-keep', 'cf-cancel']) $(b).disabled = true;
  try {
    applyJob(await api('/api/job/confirm', { remove }));
  } catch (e) {
    $('cf-sub').textContent = e.message;
    for (const b of ['cf-move', 'cf-keep', 'cf-cancel']) $(b).disabled = false;
  }
  schedule(250);
}

$('cf-move').addEventListener('click', () => answerConfirm(true));
$('cf-keep').addEventListener('click', () => answerConfirm(false));
$('cf-cancel').addEventListener('click', async () => {
  for (const b of ['cf-move', 'cf-keep', 'cf-cancel']) $(b).disabled = true;
  try { await api('/api/job/cancel', {}); } catch { /* shown by api() */ }
  schedule(100);
});

// ── keeping up with the engine ─────────────────────────────────────────
//
// Only one backup runs at a time. A scheduled run that starts while the
// person is choosing folders (or reading a result) is shown in a banner
// instead of taking over the screen; "View" opens it.

let bannerJob = null;     // the scheduled run shown in the banner
let announceSched = null; // id of a scheduled run seen running: its end gets a notification
let schedLoaded = 0;      // when the schedule list was last fetched

async function poll() {
  let job;
  try {
    job = await api('/api/job');
  } catch {
    schedule(1500); // keep trying: the run itself continues in the app
    return;
  }
  const mine = state.job && job.id === state.job.id;
  if (state.mode === 'running' || state.mode === 'confirm') {
    if (mine || job.status === 'idle' || !state.job) {
      applyJob(job);
    } else {
      // Our run ended and a scheduled one started right after it: show our
      // result (from the history), and the new run in the banner.
      let ours = null;
      try { ours = (await api('/api/history')).history.find((x) => x.id === state.job.id); } catch { /* shown by api() */ }
      if (ours) applyJob(ours); else { setMode('setup'); renderSetup(); }
      renderBanner(job);
    }
  } else if (job.status !== 'idle' && !mine && job.options && (job.options.label || state.detached)) {
    renderBanner(job); // a scheduled or queued run, or one the person stepped away from to set up another
  } else if (!mine && !FINISHED.includes(job.status) && job.status !== 'idle') {
    applyJob(job); // a backup started from another window: follow it here too
  } else {
    hideBanner();
  }
  if (job.status === 'idle') state.detached = false;
  await loadQueue();
  if (state.mode === 'setup') $('btn-start').textContent = state.editing ? 'Save Changes' : otherRunning() ? 'Add to Queue' : 'Start Backup';
  if (state.editing && !(state.queue || []).some((x) => x.id === state.editing)) { // it started, or was removed elsewhere
    state.editing = null;
    renderSetup();
    $('start-err').textContent = 'The backup you were editing is no longer in the queue (it has started, or was removed). Your changes were not saved — Add to Queue adds them as a new backup.';
    $('start-err').hidden = false;
  }
  if (Date.now() - schedLoaded > 30000) loadSchedules();
  const busy = state.mode === 'running' || state.mode === 'confirm';
  maybeShowUpdate(); // a backup may just have ended
  schedule(busy ? 400 : bannerJob && !FINISHED.includes(bannerJob.status) ? 1000 : 3000);
}

// What a background run is called: a schedule's name, a queued backup's, or its folders.
const jobKind = (job) => (job.options.queued ? 'Queued backup' : job.options.label ? 'Scheduled run' : 'Backup');
const jobName = (job) => job.options.label || job.options.sources.map(baseName).join(', ') + ' → ' + job.options.destinations.map(baseName).join(', ');

function renderBanner(job) {
  bannerJob = job;
  const finished = FINISHED.includes(job.status);
  let text, tone = '';
  if (!finished) {
    const copying = job.status === 'copying' && job.workTotal > 0;
    const pct = copying ? Math.floor((job.workDone / job.workTotal) * 100) + '%' : '';
    const where = job.status === 'confirming' ? 'needs your decision — click View'
      : job.paused ? 'paused · ' + pct
      : copying ? pct + ' · ' + fmtLeft(job) : 'preparing';
    text = jobKind(job) + (job.status === 'confirming' ? ' ' : ' in progress · ') + (job.status === 'confirming' ? '· ' : '') + jobName(job) + ' · ' + where;
    if (job.status === 'confirming') tone = 'warn';
    if (job.status === 'confirming' && announceSched !== 'ask:' + job.id && native) native.notify('G-Copy — Your decision is needed', jobName(job) + ': choose whether to clean up files that are no longer in the source.');
    announceSched = job.status === 'confirming' ? 'ask:' + job.id : job.id;
    if (native) native.setProgress(copying ? job.workDone / job.workTotal : 2, true, !!job.paused);
  } else {
    const loose = (job.options.noVerify && job.filesCopied > 0) || job.dests.some((d) => d.unverified > 0);
    const verdict = job.status === 'done' ? (loose ? 'done, not verified' : 'complete') : job.status === 'cancelled' ? 'cancelled' : 'needs a look';
    tone = job.status === 'done' ? (loose ? 'warn' : 'ok') : job.status === 'cancelled' ? 'warn' : 'bad';
    text = jobKind(job) + ' ' + verdict + ' · ' + jobName(job) + ' · ' + num(job.filesCopied) + ' copied' +
      (job.filesFailed ? ', ' + num(job.filesFailed) + ' failed' : '');
    if (native) native.setProgress(-1, false);
    if (announceSched === job.id || announceSched === 'ask:' + job.id) {
      announceSched = null;
      if (native) native.notify('G-Copy — ' + jobKind(job) + ' ' + verdict, jobName(job) + ': ' + num(job.filesCopied) + ' copied' + (job.filesFailed ? ', ' + num(job.filesFailed) + ' failed' : ''));
      loadSchedules();
    }
  }
  const b = $('sched-banner');
  b.hidden = false;
  b.dataset.tone = tone;
  $('sb-icon').setAttribute('href', '#i-' + (tone === 'ok' ? 'check' : tone === 'bad' ? 'alert' : tone === 'warn' ? (job.status === 'cancelled' ? 'stop' : 'alert') : job.paused ? 'pause' : job.options.label && !job.options.queued ? 'cal' : 'disk'));
  $('sb-text').textContent = text;
  $('sb-view').textContent = finished ? 'View Result' : 'View';
  $('sb-close').hidden = !finished;
}

function hideBanner() {
  if (bannerJob && !FINISHED.includes(bannerJob.status) && native) native.setProgress(-1, false);
  bannerJob = null;
  $('sched-banner').hidden = true;
  $('sb-text').textContent = '';
}

$('sb-view').addEventListener('click', () => {
  const job = bannerJob;
  if (!job) return;
  if (state.mode === 'setup') { // come back to these after looking
    state.saved = { sources: state.sources.map((x) => x.path), dests: state.dests.map((x) => x.path) };
  }
  hideBanner();
  state.job = null;
  state.detached = false;
  state.editing = null; // a backup being edited stays on hold; its row offers Edit and Release
  applyJob(job);
  schedule(100);
});

$('sb-close').addEventListener('click', async () => {
  const job = bannerJob;
  hideBanner();
  if (job) { try { await api('/api/job/dismiss', { id: job.id }); } catch { /* shown by api() */ } }
});

async function startJob(opts) {
  const err = $('start-err');
  err.hidden = true;
  $('btn-start').disabled = true;
  try {
    const job = await api('/api/job', opts);
    store.set('opts', { verify: !opts.noVerify, subfolder: opts.subfolder, reverify: wantRecheck(), mirror: !!opts.mirror });
    $('run-fill').style.width = '0%';
    $('run-pct').textContent = ''; // not the last run's number
    applyJob(job);
    schedule(250);
  } catch (e) {
    if (state.mode !== 'setup') { setMode('setup'); renderSetup(); }
    err.textContent = e.message;
    err.hidden = false;
    $('btn-start').disabled = false;
  }
}

// ── the queue ───────────────────────────────────────────────────────────

// otherRunning: a backup is going on that this screen is not showing in full.
const otherRunning = () => !!bannerJob && !FINISHED.includes(bannerJob.status);

async function loadQueue() {
  try { state.queue = (await api('/api/queue')).queue; } catch { return; }
  renderQueue();
}

function renderQueue() {
  const q = state.queue || [];
  $('queue-panel').hidden = q.length === 0;
  const waiting = q.filter((x) => !x.error).length;
  $('queue-sub').textContent = waiting ? plural(waiting, 'backup') + ' waiting. ' + (waiting === 1 ? 'It starts' : 'They start one after another') + ' when the running backup has finished.' : 'These could not start.';
  const act = async (path) => { try { state.queue = (await api(path, {})).queue; renderQueue(); } catch { /* shown by api() */ } };
  const editingHere = (it) => state.editing === it.id;
  $('queue-list').replaceChildren(...q.map((it, i) => h('li', { class: [it.error && 'failed', it.held && 'held'].filter(Boolean).join(' ') },
    h('span', { class: 'q-n' }, String(i + 1)),
    h('span', { class: 'q-name', title: it.options.sources.concat(it.options.destinations).join('\n') }, it.name + fmtQueueOpts(it.options)),
    h('span', { class: 'q-acts' },
      i > 0 && !it.error ? h('button', { class: 'btn small', type: 'button', 'aria-label': 'Move ' + it.name + ' up', onclick: () => act('/api/queue/' + it.id + '/up') }, 'Move Up') : null,
      editingHere(it) ? null : h('button', { class: 'btn small', type: 'button', 'aria-label': 'Edit ' + it.name, onclick: () => editQueued(it) }, 'Edit'),
      it.held && !editingHere(it) ? h('button', { class: 'btn small', type: 'button', 'aria-label': 'Let ' + it.name + ' start when its turn comes', onclick: () => act2('/api/queue/' + it.id + '/hold', { held: false }) }, 'Release') : null,
      h('button', { class: 'btn small', type: 'button', 'aria-label': 'Remove ' + it.name + ' from the queue', onclick: () => { if (editingHere(it)) stopEditing(); act('/api/queue/' + it.id + '/delete'); } }, 'Remove')),
    it.held ? h('span', { class: 'q-held' }, editingHere(it) ? 'Being edited above — it waits until you save or cancel.' : 'On hold — it does not start until released or saved.') : null,
    it.error ? h('span', { class: 'q-err' }, 'Could not start: ' + it.error) : null,
    ...queueScanLines(it),
  )));
}
const act2 = async (path, body) => { try { state.queue = (await api(path, body)).queue; renderQueue(); } catch { /* shown by api() */ } };

// What a queued backup would copy, and whether each destination will still
// have room when its turn comes (after the backups before it).
function queueScanLines(it) {
  const sc = it.scan;
  if (it.error) return [];
  if (!sc || sc.state === 'waiting') return [h('span', { class: 'q-scan' }, 'Waiting to be checked…')];
  if (sc.state === 'failed') return [h('span', { class: 'q-err' }, 'Could not be checked: ' + sc.message)];
  const p = sc.preview;
  if (!p) return [h('span', { class: 'q-scan' }, 'Checking size…')];
  const files = p.sources.reduce((n, s) => n + s.files, 0), bytes = p.sources.reduce((n, s) => n + s.bytes, 0);
  const cFiles = p.sources.reduce((n, s) => n + s.copyFiles, 0), cBytes = p.sources.reduce((n, s) => n + s.copyBytes, 0);
  const out = [h('span', { class: 'q-scan' }, plural(files, 'file') + ' · ' + fmtBytes(bytes) + ' — ' + (cFiles ? plural(cFiles, 'file') + ' · ' + fmtBytes(cBytes) + ' to copy' : 'nothing new to copy') + (sc.state === 'scanning' ? ' (checking again…)' : ''))];
  for (const r of sc.room || []) {
    const name = baseName(r.path);
    if (r.freeNow < 0) { out.push(h('span', { class: 'q-room' }, h('span', {}, name + ': needs ', h('b', {}, fmtBytes(r.need)), ' (free space unknown)'))); continue; }
    out.push(h('span', { class: 'q-room' },
      h('span', {}, name + ': needs ', h('b', {}, fmtBytes(r.need))),
      r.fits ? h('span', {}, 'about ', h('b', {}, fmtBytes(r.freeAtTurn)), ' free when its turn comes' + (r.ahead > 0 ? ' (' + fmtBytes(r.ahead) + ' still to be written before it)' : ''))
        : h('span', { class: 'short' }, icon('alert'), 'Will not fit: about ' + fmtBytes(Math.max(0, r.freeAtTurn)) + ' free when its turn comes' + (r.ahead > 0 ? ', after ' + fmtBytes(r.ahead) + ' for the backups before it' : '')),
    ));
  }
  return out;
}

// ── editing a queued backup ────────────────────────────────────────────

async function editQueued(it) {
  if (state.editing && state.editing !== it.id) await stopEditing();
  try { state.queue = (await api('/api/queue/' + it.id + '/hold', { held: true })).queue; } catch { return; }
  // to the set-up screen, the running backup (if shown) goes to the banner
  if (state.mode === 'running' || state.mode === 'confirm') $('btn-add-job').click();
  else if (state.mode === 'finished') { try { await api('/api/job/dismiss', { id: state.job && state.job.id }); } catch { /* */ } state.job = null; setMode('setup'); }
  const o = it.options;
  state.editing = it.id;
  state.sources = o.sources.map(item);
  state.dests = o.destinations.map(item);
  sizes.clear();
  $('opt-subfolder').checked = o.subfolder !== false;
  $('opt-mirror').checked = !!o.mirror;
  $('opt-verify').checked = !o.noVerify;
  $('opt-reverify').disabled = false;
  $('opt-reverify').checked = recheckWanted = !!o.reverify;
  renderSetup();
  refreshDests();
  renderQueue();
  window.scrollTo(0, 0);
}

async function stopEditing(release = true) {
  const id = state.editing;
  state.editing = null;
  if (release && id) { try { state.queue = (await api('/api/queue/' + id + '/hold', { held: false })).queue; } catch { /* it may have gone */ } }
  state.sources = [];
  sizes.clear();
  renderSetup();
  renderQueue();
}

async function saveQueued(opts) {
  const err = $('start-err');
  err.hidden = true;
  $('btn-start').disabled = true;
  try {
    state.queue = (await api('/api/queue/' + state.editing, opts)).queue;
    state.editing = null;
    state.sources = [];
    sizes.clear();
    renderSetup();
    renderQueue();
  } catch (e) {
    err.textContent = e.message; // e.g. it started meanwhile: the fields stay, Add to Queue still works
    err.hidden = false;
    if (/no longer in the queue/.test(e.message)) state.editing = null;
    renderSetup();
    err.hidden = false;
  }
}

$('btn-edit-cancel').addEventListener('click', () => stopEditing());
const fmtQueueOpts = (o) => { const x = [o.mirror && 'sync', o.reverify && 're-check', o.noVerify && 'not verified'].filter(Boolean); return x.length ? '  ·  ' + x.join(' · ') : ''; };

async function addToQueue(opts) {
  const err = $('start-err');
  err.hidden = true;
  $('btn-start').disabled = true;
  try {
    state.queue = (await api('/api/queue', opts)).queue;
    store.set('opts', { verify: !opts.noVerify, subfolder: opts.subfolder, reverify: wantRecheck(), mirror: !!opts.mirror });
    state.sources = []; // the next card, to the same place
    sizes.clear();
    renderQueue();
    renderSetup();
    schedule(100);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    $('btn-start').disabled = false;
  }
}

$('btn-start').addEventListener('click', () => (state.editing ? saveQueued(options()) : otherRunning() ? addToQueue(options()) : startJob(options())));

// Step away from the running backup to set up another: it carries on, shown in the banner.
$('btn-add-job').addEventListener('click', () => {
  const job = state.job;
  if (!job) return;
  state.detached = true;
  state.job = null;
  state.sources = [];
  state.dests = state.dests.map((d) => item(d.path));
  sizes.clear();
  setMode('setup');
  document.title = 'G-Copy';
  renderBanner(job);
  renderSetup();
  refreshDests();
  schedule(100);
});

$('btn-pause').addEventListener('click', async () => {
  const job = state.job;
  if (!job) return;
  $('btn-pause').disabled = true;
  try { applyJob(await api(job.paused ? '/api/job/resume' : '/api/job/pause', {})); } catch { /* shown by api(); the next poll puts the button right */ }
  $('btn-pause').disabled = false;
  schedule(250);
});

let cancelArmed = 0;
$('btn-cancel').addEventListener('click', async () => {
  const btn = $('btn-cancel');
  if (!cancelArmed) { // ask once more, without a system dialog
    btn.textContent = 'Really cancel?';
    cancelArmed = setTimeout(() => { cancelArmed = 0; btn.textContent = 'Cancel'; }, 3000);
    return;
  }
  clearTimeout(cancelArmed);
  cancelArmed = 0;
  btn.textContent = 'Cancel';
  try { await api('/api/job/cancel', {}); } catch { /* shown by api() */ }
});

$('btn-retry').addEventListener('click', async () => {
  const opts = state.job.options;
  try { await api('/api/job/dismiss', { id: state.job.id }); } catch { return; }
  state.job = null;
  await startJob(opts);
});

$('btn-new').addEventListener('click', async () => {
  try { await api('/api/job/dismiss', { id: state.job && state.job.id }); } catch { return; }
  state.job = null;
  sizes.clear();
  if (state.saved) { // back to what was being set up before looking at a scheduled run
    state.sources = state.saved.sources.map(item);
    state.dests = state.saved.dests.map(item);
    state.saved = null;
  } else {
    state.sources = [];                       // the next drive…
    state.dests = state.dests.map((d) => item(d.path)); // …to the same place
  }
  setMode('setup');
  document.title = 'G-Copy';
  renderSetup();
  refreshDests();
});

for (const id of ['opt-subfolder', 'opt-reverify', 'opt-mirror', 'opt-verify']) $(id).addEventListener('change', renderSetup);

// ── folder picker ───────────────────────────────────────────────────────

const picker = { kind: 'src', path: '', free: null, volumes: [], typed: false };

// Once the person types in the path field, nothing loading in the
// background may replace what they typed.
$('path-input').addEventListener('input', () => { picker.typed = true; });

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
    v.total > 0 ? fmtBytes(v.free) + ' free of ' + fmtBytes(v.total) : '',
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
  picker.total = data.total ?? null;
  // Never change the field while the person is in it (or has typed in it),
  // unless this is the path they just asked for.
  const busyTyping = picker.typed || document.activeElement === input;
  if (!busyTyping || path === input.value.trim()) { input.value = data.path; picker.typed = false; }
  $('picker-chosen').textContent = tailPath(data.path);
  $('picker-choose').disabled = false;

  const rows = [];
  if (data.parent) {
    rows.push(h('li', {}, h('button', { class: 'dir up', type: 'button', onclick: () => browse(data.parent) }, icon('up'), h('span', {}, 'Enclosing folder'))));
  }
  for (const d of data.dirs) {
    rows.push(h('li', {}, h('button', { class: 'dir', type: 'button', onclick: () => browse(d.path) }, icon('folder'), h('span', {}, d.name))));
  }
  if (!data.dirs.length) {
    rows.push(h('li', { class: 'empty' }, 'No folders inside' + (data.files ? ' (' + plural(data.files, 'file') + ')' : '') + '. Click "Choose This Folder" to use this one.'));
  }
  $('dir-list').replaceChildren(...rows);
  $('dir-list').scrollTop = 0;
  renderSide();
  return true;
}

async function openPicker(kind) {
  picker.kind = kind;
  picker.path = '';
  picker.typed = false;
  $('path-input').value = '';
  $('picker-title').textContent = kind === 'src' ? 'Choose Source' : 'Choose Destination';
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
  if (seq !== browseSeq || picker.typed || document.activeElement === $('path-input')) return; // the user already went somewhere, or is typing
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

function addFolder(kind, path, free, total) {
  const list = kind === 'src' ? state.sources : state.dests;
  if (!list.some((x) => x.path === path)) list.push({ ...item(path), free, total });
  if (kind === 'src') sizes.delete(path); // measure it afresh
  const key = 'recent.' + kind;
  store.set(key, [path, ...store.get(key, []).filter((p) => p !== path)].slice(0, 6));
  saveDests();
  renderSetup();
}

$('picker-choose').addEventListener('click', () => {
  if (!picker.path) return;
  addFolder(picker.kind, picker.path, picker.free, picker.total);
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
      addFolder(kind, info.path, info.free ?? null, info.total ?? null);
    } catch (e) {
      problems.push(/not found/i.test(e.message) ? 'Only folders can be added: ' + p : e.message);
    }
  }
  if (problems.length) {
    err.textContent = problems.join('  ·  ');
    err.hidden = false;
  }
}

if (native) {
  const btn = $('btn-native');
  btn.textContent = native.platform === 'darwin' ? 'Choose in Finder…' : native.platform === 'win32' ? 'Choose in Explorer…' : 'Choose in File Manager…';
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
    list.replaceChildren(h('li', { class: 'empty' }, 'No history yet. Finished backups appear here.'));
    return;
  }
  const df = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  list.replaceChildren(...items.map((j) => {
    const loose = (j.options.noVerify && j.filesCopied > 0) || (j.dests || []).some((d) => d.unverified > 0);
    const tone = j.status === 'done' ? (loose ? 'warn' : 'ok') : j.status === 'cancelled' ? 'warn' : 'bad';
    const ico = icon(j.status === 'done' ? (loose ? 'alert' : 'check') : j.status === 'cancelled' ? 'stop' : 'alert');
    ico.classList.add(tone);
    const what = j.options.sources.map(baseName).join(', ') + '  →  ' + j.options.destinations.map(baseName).join(', ');
    let detail = num(j.filesCopied) + ' copied · ' + fmtBytes(j.bytesCopied) + ' · ' + num(j.filesSkipped) + ' skipped · ' + fmtDur(j.seconds);
    const gone = (j.dests || []).reduce((n, d) => n + (d.removed || 0), 0);
    if (gone > 0) detail += ' · ' + num(gone) + ' cleaned up';
    if (loose) detail = 'Not verified · ' + detail;
    if (j.options.label) detail = (j.options.queued ? 'Queued · ' : 'Scheduled · ' + j.options.label + ' · ') + detail;
    if (j.status === 'cancelled') detail = 'Cancelled · ' + detail;
    if (j.status === 'failed') detail = (j.message || num(j.filesFailed) + ' failed · ' + plural(j.errorCount, 'problem')) + (j.message ? '' : ' · ' + detail);
    // A run that failed or was cancelled can be opened again, with its list of problems.
    const busy = state.mode === 'running' || state.mode === 'confirm';
    const view = j.status === 'done' ? null : h('button', { class: 'btn small view', type: 'button', disabled: busy, title: busy ? 'Available when the backup that is running has finished' : null, onclick: () => viewPast(j) }, 'View Problems');
    return h('li', {}, ico, h('span', { class: 'what', title: what }, what), h('span', { class: 'when' }, df.format(new Date(j.startedAt))), view, h('span', { class: 'detail' }, detail));
  }));
});

// viewPast shows an earlier run's result again, the way "View Result" does
// for a scheduled run. Not while a backup is running in this window.
function viewPast(job) {
  if (state.mode === 'running' || state.mode === 'confirm') return;
  $('history').close();
  if (state.mode === 'finished' && state.job) api('/api/job/dismiss', { id: state.job.id }).catch(() => {}); // the result on screen makes way
  if (state.mode === 'setup') { // come back to these after looking
    state.saved = { sources: state.sources.map((x) => x.path), dests: state.dests.map((x) => x.path) };
  }
  state.job = null;
  applyJob(job);
  window.scrollTo(0, 0);
}

// ── schedules ───────────────────────────────────────────────────────────

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // shown Monday first
const sched = { list: [], editing: null, armed: null };
const two = (n) => String(n).padStart(2, '0');

function fmtAt(iso) {
  const d = new Date(iso), now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const hm = two(d.getHours()) + ':' + two(d.getMinutes());
  if (days === 0) return 'today ' + hm;
  if (days === 1) return 'tomorrow ' + hm;
  if (days === -1) return 'yesterday ' + hm;
  return WEEK[d.getDay()] + ', ' + MONTH[d.getMonth()] + ' ' + d.getDate() + ' ' + hm;
}

function fmtWhen(w) {
  if (w.kind === 'daily') return 'Daily at ' + w.time;
  if (w.kind === 'weekly') {
    const days = WEEK_ORDER.filter((d) => w.days.includes(d));
    const label = days.length === 5 && !days.includes(0) && !days.includes(6) ? 'weekdays' : days.map((d) => WEEK[d]).join(', ');
    return 'Weekly on ' + label + ' at ' + w.time;
  }
  return w.hours === 1 ? 'Every hour' : 'Every ' + w.hours + ' hours';
}

function fmtWhat(o) {
  const extras = [o.mirror && 'sync', o.reverify && 're-check', o.noVerify && 'not verified'].filter(Boolean);
  return o.sources.map(baseName).join(', ') + '  →  ' + o.destinations.map(baseName).join(', ') + (extras.length ? '  ·  ' + extras.join(' · ') : '');
}

function fmtLast(l) {
  const when = 'Last run ' + fmtAt(l.at) + ' · ';
  if (l.status === 'done') return [l.unverified ? 'warn' : 'ok', when + 'done, ' + num(l.copied) + ' copied' + (l.unverified ? ' (not verified)' : '') + (l.removed ? ', ' + num(l.removed) + ' cleaned up' : '')];
  if (l.status === 'skipped') return ['warn', when + 'skipped — the disk was not connected', l.message];
  if (l.status === 'cancelled') return ['warn', when + 'cancelled'];
  return ['bad', when + 'needs a look' + (l.failed ? ' — ' + num(l.failed) + ' failed' : '') + (l.message ? ' — ' + l.message : '')];
}

async function loadSchedules() {
  schedLoaded = Date.now();
  try { sched.list = (await api('/api/schedules')).schedules; } catch { return; }
  renderNextRun();
  if ($('schedules').open) renderSchedules();
}

function renderNextRun() {
  const on = sched.list.filter((s) => s.enabled && s.nextRun);
  const next = on.slice().sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun))[0];
  $('next-run').textContent = next ? '· ' + fmtAt(next.nextRun) : '';
  if (native && native.setScheduleInfo) {
    native.setScheduleInfo(on.length, next ? 'Next: ' + fmtAt(next.nextRun) + '  ' + next.name : 'No active schedules');
  }
}

function renderSchedules() {
  const list = $('sched-list');
  const ready = state.mode === 'setup' && state.sources.length > 0 && state.dests.length > 0;
  $('sched-add').disabled = !ready;
  $('sched-add').title = ready ? '' : 'First choose a source and a destination on the main screen';
  if (!sched.list.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No schedules yet. Choose a source and a destination on the main screen, then click "Save as Schedule…".'));
    return;
  }
  list.replaceChildren(...sched.list.map((sc) => {
    const toggle = h('input', { type: 'checkbox', 'aria-label': 'Turn on ' + sc.name });
    toggle.checked = sc.enabled;
    toggle.addEventListener('change', async () => {
      try { await api('/api/schedules/' + sc.id, { enabled: toggle.checked }); } catch { toggle.checked = !toggle.checked; }
      loadSchedules();
    });
    let now = null;
    if (sc.running) now = h('p', { class: 's-now' }, 'Running now');
    else if (sc.queued) now = h('p', { class: 's-now' }, 'Waiting — runs when the current backup finishes');
    const last = sc.last ? fmtLast(sc.last) : null;
    const del = h('button', { class: 'btn ghost', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      if (sched.armed !== sc.id) { // ask once more
        sched.armed = sc.id;
        del.textContent = 'Really delete';
        setTimeout(() => { if (sched.armed === sc.id) { sched.armed = null; del.textContent = 'Delete'; } }, 3000);
        return;
      }
      sched.armed = null;
      try { await api('/api/schedules/' + sc.id + '/delete', {}); } catch { /* shown by api() */ }
      loadSchedules();
    });
    return h('li', { class: 'sched' + (sc.enabled ? '' : ' off') },
      h('label', { class: 'switch' }, toggle, h('span')),
      h('div', { class: 's-main' },
        h('p', { class: 's-name' }, sc.name),
        h('p', { class: 's-when' }, fmtWhen(sc.when) + (sc.enabled && sc.nextRun ? '  ·  next ' + fmtAt(sc.nextRun) : sc.enabled ? '' : '  ·  off')),
        h('p', { class: 's-what', title: sc.options.sources.concat(sc.options.destinations).join('\n') }, fmtWhat(sc.options)),
        now,
        last ? h('p', { class: 's-last ' + last[0], title: last[2] || null }, last[1]) : null,
      ),
      h('div', { class: 's-actions' },
        h('button', { class: 'btn ghost', type: 'button', disabled: sc.running || sc.queued, onclick: async () => {
          try { await api('/api/schedules/' + sc.id + '/run', {}); } catch { return; }
          $('schedules').close();
          schedule(150);
          loadSchedules();
        } }, 'Run Now'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openEditor(sc) }, 'Edit'),
        del,
      ),
    );
  }));
}

$('btn-schedules').addEventListener('click', async () => {
  $('schedules').showModal();
  renderSchedules();
  loadSchedules();
  if (native) $('login-item').checked = await native.getLoginItem();
});
$('login-item').addEventListener('change', () => native && native.setLoginItem($('login-item').checked));
$('sched-add').addEventListener('click', () => { $('schedules').close(); openEditor(null); });
$('btn-save-sched').addEventListener('click', () => openEditor(null));

// the editor

$('se-days').replaceChildren(...WEEK_ORDER.map((d) => h('label', {},
  h('input', { type: 'checkbox', value: String(d), 'aria-label': WEEK[d] }), h('span', {}, WEEK[d]))));

// Time of day: 24-hour, like everywhere else on the screen. Minutes in
// steps of five; a schedule saved with another minute keeps it.
$('se-hour').replaceChildren(...Array.from({ length: 24 }, (_, i) => h('option', { value: two(i) }, two(i))));
function setTime(hhmm) {
  const [hh, mm] = /^\d{1,2}:\d{2}$/.test(hhmm) ? hhmm.split(':').map((x) => two(Number(x))) : ['02', '00'];
  const mins = Array.from({ length: 12 }, (_, i) => two(i * 5));
  if (!mins.includes(mm)) { mins.push(mm); mins.sort(); }
  $('se-min').replaceChildren(...mins.map((m) => h('option', { value: m }, m)));
  $('se-hour').value = hh;
  $('se-min').value = mm;
}

function editorKind() { return document.querySelector('input[name="se-kind"]:checked').value; }

function renderEditorRows() {
  const kind = editorKind();
  $('se-days-row').hidden = kind !== 'weekly';
  $('se-time-row').hidden = kind === 'hours';
  $('se-hours-row').hidden = kind !== 'hours';
}
for (const r of document.querySelectorAll('input[name="se-kind"]')) r.addEventListener('change', renderEditorRows);

function openEditor(sc) {
  sched.editing = sc;
  const opts = sc ? sc.options : options();
  const w = sc ? sc.when : { kind: 'daily', time: '02:00', days: [1, 2, 3, 4, 5], hours: 6 };
  $('se-title').textContent = sc ? 'Edit Schedule' : 'Save as Schedule';
  $('se-name').value = sc ? sc.name : opts.sources.map(baseName).join(', ') + ' → ' + opts.destinations.map(baseName).join(', ');
  document.querySelector('input[name="se-kind"][value="' + w.kind + '"]').checked = true;
  setTime(w.time || '02:00');
  $('se-hours').value = String(w.hours || 6);
  const days = w.days && w.days.length ? w.days : [1, 2, 3, 4, 5];
  for (const c of $('se-days').querySelectorAll('input')) c.checked = days.includes(Number(c.value));
  renderEditorRows();

  $('se-what').replaceChildren(
    h('b', {}, 'Source '), opts.sources.map(baseName).join(', '), '  →  ', h('b', {}, 'Destination '), opts.destinations.map(baseName).join(', '),
    [opts.subfolder && ' · folder named after source', opts.mirror && ' · sync', opts.reverify && ' · re-check earlier copies', opts.noVerify && ' · not verified'].filter(Boolean).join(''),
  );
  const notes = [
    h('li', {}, native ? 'Runs while G-Copy is open. Closing the window keeps G-Copy running in the menu bar.' : 'Runs only while G-Copy is running.'),
    h('li', {}, 'A run missed because the Mac was asleep or G-Copy was closed is made up once, as soon as possible.'),
    h('li', {}, 'If a disk is not connected at that time, that run is skipped and noted.'),
  ];
  if (opts.noVerify) notes.push(h('li', { class: 'warn' }, 'Verification is off: these runs copy files without checking them, and write no checksum report.'));
  if (opts.mirror) {
    notes.push(h('li', { class: 'warn' }, 'Sync: scheduled runs move files no longer in the source to _G-Copy_Removed without asking — except when the source is empty or more than 25% of a destination would be moved; then nothing is moved and it is noted.'));
  }
  $('se-notes').replaceChildren(...notes);
  $('se-err').hidden = true;
  $('se-save').disabled = false;
  $('sched-edit').showModal();
  $('se-name').select();
}

$('se-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = editorKind();
  const when = { kind };
  if (kind !== 'hours') when.time = $('se-hour').value + ':' + $('se-min').value;
  if (kind === 'weekly') when.days = [...$('se-days').querySelectorAll('input:checked')].map((c) => Number(c.value));
  if (kind === 'hours') when.hours = Number($('se-hours').value);
  const body = { name: $('se-name').value, when };
  const sc = sched.editing;
  if (!sc) body.options = options();
  $('se-save').disabled = true;
  try {
    await api(sc ? '/api/schedules/' + sc.id : '/api/schedules', body);
  } catch (ex) {
    $('se-err').textContent = ex.message;
    $('se-err').hidden = false;
    $('se-save').disabled = false;
    return;
  }
  $('sched-edit').close();
  if (!sc) store.set('opts', { verify: !body.options.noVerify, subfolder: body.options.subfolder, reverify: wantRecheck(), mirror: !!body.options.mirror });
  await loadSchedules();
  $('schedules').showModal();
  renderSchedules();
});

// ── updates (desktop app only) ─────────────────────────────────────────

const updates = { state: null };

function renderUpdate(st) {
  updates.state = st;
  const pill = $('update-pill');
  if (st.status === 'ready') {
    pill.hidden = false;
    pill.classList.remove('loading');
    $('update-pill-text').textContent = 'Update ' + st.version + ' ready';
    pill.setAttribute('aria-label', 'Update ' + st.version + ' ready'); pill.title = 'Update ' + st.version + ' ready';
  } else if (st.status === 'available') { // found, not downloaded: automatic updates are switched off
    pill.hidden = false;
    pill.classList.remove('loading');
    $('update-pill-text').textContent = 'Update ' + st.version + ' available';
    pill.setAttribute('aria-label', $('update-pill-text').textContent); pill.title = 'Click to download it';
  } else if (st.status === 'downloading') {
    pill.hidden = false;
    pill.classList.add('loading');
    $('update-pill-text').textContent = 'Downloading ' + st.version + (st.progress ? ' · ' + Math.floor(st.progress * 100) + '%' : '');
    pill.setAttribute('aria-label', $('update-pill-text').textContent); pill.title = $('update-pill-text').textContent;
  } else {
    pill.hidden = true;
  }
  if ($('update-dlg').open && UPD.mode === 'update') renderUpdateDialog();
  else if ($('update-dlg').open && UPD.mode === 'checking' && ['downloading', 'ready', 'available'].includes(st.status)) openUpdateDialog('update');
  maybeShowUpdate();
}

// The update window. It opens by itself once for each new version (when
// nothing else is going on), and whenever the top-bar button or the menu's
// "Check for Updates…" is used.
const UPD = { mode: 'update', message: '' }; // mode: update | checking | uptodate | error

function renderUpdateDialog() {
  const st = updates.state || {};
  const busy = state.mode === 'running' || state.mode === 'confirm' || (bannerJob && !FINISHED.includes(bannerJob.status));
  const show = (id, on) => { $(id).hidden = !on; };
  const btn = $('up-install'), later = $('up-later');
  show('up-progress', false);
  show('up-dot', true);
  $('up-notes').textContent = '';
  $('up-versions').textContent = '';
  $('up-sub').textContent = '';
  $('up-sub').title = '';
  later.hidden = false; later.textContent = 'Later';
  btn.hidden = false; btn.disabled = false; btn.title = '';
  if (UPD.mode === 'checking') {
    show('up-dot', false);
    $('up-title').textContent = 'Checking for updates…';
    btn.hidden = true; later.textContent = 'Close';
    $('up-hint').textContent = '';
    return;
  }
  if (UPD.mode === 'uptodate') {
    show('up-dot', false);
    $('up-title').textContent = 'G-Copy is up to date';
    $('up-sub').textContent = 'Version ' + (st.current || '') + ' is the latest.';
    later.hidden = true; btn.textContent = 'OK';
    $('up-hint').textContent = '';
    return;
  }
  if (UPD.mode === 'error') {
    show('up-dot', false);
    $('up-title').textContent = 'Could not check for updates';
    // in plain words; the technical reason is kept for whoever needs it
    const why = String(UPD.message || '');
    $('up-sub').textContent = /net::|ENOTFOUND|ECONN|ETIMEDOUT|timed? ?out|abort|fetch failed/i.test(why) || !why
      ? 'The update server could not be reached. Check the internet connection, then Try Again.'
      : why;
    $('up-sub').title = why;
    later.textContent = 'Close'; btn.textContent = 'Try Again';
    $('up-hint').textContent = '';
    return;
  }
  $('up-title').textContent = 'A new version is available';
  $('up-versions').textContent = (st.current || '') + ' → ' + (st.version || '');
  $('up-notes').textContent = st.notes || '';
  if (st.status === 'available') { // automatic updates are off: download when asked
    btn.textContent = 'Download';
    $('up-hint').textContent = 'Automatic updates are off, so it has not been downloaded yet.';
  } else if (st.status === 'downloading') {
    show('up-progress', true);
    const p = Math.floor((st.progress || 0) * 100);
    $('up-fill').style.width = p + '%';
    $('up-pct').textContent = p + '%';
    btn.textContent = 'Restart to Update'; btn.disabled = true;
    $('up-hint').textContent = 'Downloading and checking the update…';
  } else {
    btn.textContent = 'Restart to Update';
    btn.disabled = busy;
    btn.title = busy ? 'Wait until the backup has finished' : '';
    $('up-hint').textContent = busy ? 'A backup is running — it will be installed after you quit G-Copy.' : 'Choose Later and it installs when you quit G-Copy.';
  }
}

function openUpdateDialog(mode = 'update') {
  UPD.mode = mode;
  $('up-err').hidden = true;
  renderUpdateDialog();
  if (!$('update-dlg').open) $('update-dlg').showModal();
}

// A new version opens the window by itself, once per version, but never
// over a backup in progress, a paused one, a sync question or another window.
let storeReady = false;
function maybeShowUpdate() {
  const st = updates.state;
  if (!native || !storeReady || !st || !st.version || !['downloading', 'ready', 'available'].includes(st.status)) return;
  if (store.get('updateShown', '') === st.version) return;
  const busy = state.mode === 'running' || state.mode === 'confirm' || (bannerJob && !FINISHED.includes(bannerJob.status));
  if (busy || document.querySelector('dialog[open]')) return;
  store.set('updateShown', st.version);
  openUpdateDialog('update');
}

async function checkNow() { // the menu's "Check for Updates…" and Try Again
  openUpdateDialog('checking');
  let r;
  try { r = await native.checkUpdate(); } catch (e) { r = { status: 'error', message: e.message }; }
  if (!$('update-dlg').open) return; // closed meanwhile
  if (r.status === 'uptodate') openUpdateDialog('uptodate');
  else if (r.status === 'error' || r.status === 'unavailable') { UPD.message = r.message; openUpdateDialog('error'); }
  else openUpdateDialog('update');
}

if (native && native.getUpdate) {
  $('update-pill').addEventListener('click', () => openUpdateDialog('update'));
  $('up-install').addEventListener('click', async () => {
    if (UPD.mode === 'uptodate') { $('update-dlg').close(); return; }
    if (UPD.mode === 'error') { checkNow(); return; }
    const st = updates.state || {};
    if (st.status === 'available') { native.checkUpdate(); return; } // download it now; the window follows the progress
    $('up-install').disabled = true;
    const r = await native.installUpdate();
    if (r.status !== 'installing') {
      $('up-err').textContent = r.message || 'The update could not be installed.';
      $('up-err').hidden = false;
      renderUpdateDialog();
    } else {
      $('up-install').textContent = 'Restarting…';
    }
  });
  native.onUpdate(renderUpdate);
  native.getUpdate().then(renderUpdate);
  if (native.onCheckRequest) native.onCheckRequest(checkNow);
  // when a window closes, or a backup ends, a waiting update may be shown
  for (const dlg of document.querySelectorAll('dialog')) dlg.addEventListener('close', () => setTimeout(maybeShowUpdate, 300));
}

// ── start-up ────────────────────────────────────────────────────────────

// refreshDests re-reads free space and drops destinations that are no
// longer connected.
async function refreshDests() {
  const free = new Map(), gone = new Set();
  for (const d of [...state.dests]) {
    try {
      const info = await api('/api/browse?path=' + encodeURIComponent(d.path));
      free.set(d.path, [info.free ?? null, info.total ?? null]);
    } catch { gone.add(d.path); /* not mounted today */ }
  }
  if (state.mode !== 'setup') return;
  // Apply to the list as it is now: the user may have changed it meanwhile.
  state.dests = state.dests.filter((d) => !gone.has(d.path));
  for (const d of state.dests) if (free.has(d.path)) [d.free, d.total] = free.get(d.path);
  renderSetup();
}

(async function init() {
  await store.load();
  storeReady = true;
  const o = store.get('opts', null);
  if (o) {
    $('opt-verify').checked = o.verify !== false; // settings from versions with a checksum menu (xxHash64 / MD5): on
    $('opt-subfolder').checked = o.subfolder !== false;
    $('opt-reverify').checked = recheckWanted = !!o.reverify;
    $('opt-mirror').checked = !!o.mirror;
  }
  renderSetup();
  let job;
  try {
    state.volumes = (await api('/api/volumes')).volumes;
    job = await api('/api/job');
  } catch { schedule(1500); return; }
  loadSchedules();
  if (job.status !== 'idle' && !(job.options && job.options.label)) {
    applyJob(job); // a backup someone started (this window was reloaded)
    schedule(state.mode === 'running' || state.mode === 'confirm' ? 400 : 3000);
    return;
  }
  if (job.status !== 'idle') renderBanner(job); // a scheduled run: do not take over
  // Remember where backups went last time: the NAS path rarely changes.
  state.dests = store.get('dests', []).map(item);
  refreshDests();
  schedule(job.status !== 'idle' ? 1000 : 3000);
})();
