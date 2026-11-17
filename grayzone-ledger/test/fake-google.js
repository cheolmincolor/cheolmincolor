'use strict';
/**
 * 테스트용 가짜 구글: Sheets API 와 OAuth 토큰 주소를 메모리 안에서 흉내 냅니다. 데이터는 모두 지어낸 것입니다.
 *
 * 행 묶음(그룹)은 실제 Google Sheets 에서 확인한 대로 움직입니다:
 * 묶음의 마지막 행 바로 아래(startIndex = 묶음 끝)에 행을 넣으면 그 묶음과 바깥 묶음이 함께 늘어나고,
 * inheritFromBefore 로 넣은 행은 바로 위 행의 서식·드롭다운을 물려받습니다.
 */

const crypto = require('crypto');
const { isoToSerial } = require('../src/core');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const COLS = 19;
const ID = 'FAKE_SPREADSHEET_ID_0123456789';
const SHEET_ID = 11;

const clone = (x) => JSON.parse(JSON.stringify(x));
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class FakeGoogle {
  constructor({ rows, groups, extraRows = 40 }) {
    this.grid = rows.map((r) => ({ v: pad(r.v), f: r.f || {} }));
    for (let i = 0; i < extraRows; i++) this.grid.push({ v: pad([]), f: {} });
    this.groups = groups;
    this.calls = [];
    this.tokenSeq = 0;
    this.valid = new Set();
    this.refreshTokens = new Set();
    this.codes = new Map();
    this.failNext = null;
    this.grantScope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets';
    this.fetch = this.fetch.bind(this);
  }

  // ----- 조회 도우미 -----
  rowOf(title) { return this.grid.findIndex((r) => r.v[4] === title) + 1; }
  cells(row) { return this.grid[row - 1].v; }
  depth(row) { return this.groups.filter((g) => g.start <= row - 1 && row - 1 < g.end).length; }
  expireTokens() { this.valid.clear(); }

  // ----- fetch -----
  async fetch(url, init = {}) {
    const method = init.method || 'GET';
    this.calls.push({ method, url });
    if (url === 'https://oauth2.googleapis.com/token') return this.token(new URLSearchParams(init.body));
    if (url === 'https://oauth2.googleapis.com/revoke') { this.refreshTokens.delete(new URLSearchParams(init.body).get('token')); return res(200, {}); }
    if (!url.startsWith(SHEETS)) throw new Error('가짜 구글이 모르는 주소: ' + url);
    if (this.failNext) { const f = this.failNext; this.failNext = null; return res(f.status, f.body); }

    const auth = (init.headers || {}).Authorization || '';
    if (!this.valid.has(auth.replace('Bearer ', ''))) return res(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    const rest = url.slice(SHEETS.length);
    const [idPart, query = ''] = rest.split('?');
    const id = decodeURIComponent(idPart.split(/[/:]/)[0]);
    if (id !== ID) return res(404, { error: { code: 404, message: 'Requested entity was not found.' } });

    if (method === 'GET' && idPart === encodeURIComponent(ID)) {
      return res(200, {
        properties: { title: '가짜 매출 장부' },
        sheets: [
          { properties: { sheetId: 10, title: '요약', gridProperties: { rowCount: 200 } } },
          { properties: { sheetId: SHEET_ID, title: this.sheetTitle || '장부', gridProperties: { rowCount: this.grid.length } } },
        ],
      });
    }
    if (method === 'GET' && idPart.includes('/values/')) {
      const range = decodeURIComponent(idPart.split('/values/')[1]);
      const m = range.match(/^'장부'!A1:P(\d+)$/);
      if (!m) return res(400, { error: { message: 'unexpected range ' + range } });
      if (!/valueRenderOption=UNFORMATTED_VALUE/.test(query)) return res(400, { error: { message: 'expected unformatted values' } });
      const values = this.grid.slice(0, Number(m[1])).map((r) => trimRow(r.v.slice(0, 16)));
      while (values.length && !values[values.length - 1].length) values.pop();
      return res(200, { range, values });
    }
    if (method === 'POST' && idPart.endsWith(':batchUpdate')) {
      const { requests } = JSON.parse(init.body);
      const saved = clone({ grid: this.grid, groups: this.groups });
      try {
        requests.forEach((r) => this.apply(r));
      } catch (e) {
        this.grid = saved.grid; this.groups = saved.groups; // 하나라도 실패하면 아무것도 바뀌지 않습니다.
        return res(400, { error: { code: 400, message: e.message } });
      }
      this.batches = (this.batches || 0) + 1;
      return res(200, { replies: requests.map(() => ({})) });
    }
    return res(400, { error: { message: `unexpected ${method} ${url}` } });
  }

  apply(r) {
    const [kind] = Object.keys(r);
    const q = r[kind];
    if (kind === 'insertDimension') {
      const { sheetId, dimension, startIndex: s, endIndex: e } = q.range;
      if (sheetId !== SHEET_ID || dimension !== 'ROWS') throw new Error('bad insert');
      const n = e - s;
      const from = q.inheritFromBefore && s > 0 ? this.grid[s - 1].f : {};
      for (let i = 0; i < n; i++) this.grid.splice(s, 0, { v: pad([]), f: clone(from) });
      for (const g of this.groups) {
        if (s <= g.start) { g.start += n; g.end += n; } else if (s <= g.end) g.end += n;
      }
      return;
    }
    if (kind === 'updateCells') {
      if (q.fields !== 'userEnteredValue') throw new Error('unexpected fields ' + q.fields);
      if (q.range) {
        const g = q.range;
        if (g.sheetId !== SHEET_ID || q.rows) throw new Error('bad clear');
        checkCols(g.startColumnIndex, g.endColumnIndex);
        for (let row = g.startRowIndex; row < g.endRowIndex; row++) for (let c = g.startColumnIndex; c < g.endColumnIndex; c++) this.grid[row].v[c] = '';
        return;
      }
      const { sheetId, rowIndex, columnIndex } = q.start;
      if (sheetId !== SHEET_ID) throw new Error('bad sheet');
      q.rows.forEach((row, i) => {
        checkCols(columnIndex, columnIndex + row.values.length);
        row.values.forEach((cell, k) => {
          const u = cell.userEnteredValue;
          if (u && 'formulaValue' in u) throw new Error('formula written');
          this.grid[rowIndex + i].v[columnIndex + k] = !u ? '' : 'numberValue' in u ? u.numberValue : u.stringValue;
        });
      });
      return;
    }
    if (kind === 'repeatCell') {
      if (q.fields !== 'userEnteredFormat.numberFormat') throw new Error('unexpected fields ' + q.fields);
      const g = q.range;
      checkCols(g.startColumnIndex, g.endColumnIndex);
      for (let row = g.startRowIndex; row < g.endRowIndex; row++) for (let c = g.startColumnIndex; c < g.endColumnIndex; c++) {
        this.grid[row].f[c] = q.cell.userEnteredFormat.numberFormat.pattern;
      }
      return;
    }
    throw new Error('가짜 구글이 모르는 요청: ' + kind);
  }

  // ----- OAuth -----
  /** 사용자가 브라우저에서 로그인·허용한 것처럼 리디렉트 주소로 코드를 보냅니다. */
  async approve(authUrl, { deny = false } = {}) {
    const u = new URL(authUrl);
    const p = u.searchParams;
    if (p.get('code_challenge_method') !== 'S256' || p.get('response_type') !== 'code') throw new Error('bad auth url');
    const redirect = new URL(p.get('redirect_uri'));
    if (redirect.hostname !== '127.0.0.1') throw new Error('redirect must be loopback');
    const back = new URL(p.get('redirect_uri'));
    back.searchParams.set('state', p.get('state'));
    if (deny) back.searchParams.set('error', 'access_denied');
    else {
      const code = 'code-' + crypto.randomBytes(4).toString('hex');
      this.codes.set(code, { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), client: p.get('client_id') });
      back.searchParams.set('code', code);
    }
    const r = await fetch(back);
    return r.text();
  }

  token(p) {
    if (p.get('client_secret') !== 'fake-secret') return res(401, { error: 'invalid_client' });
    if (p.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(p.get('code'));
      this.codes.delete(p.get('code'));
      if (!c || c.redirect !== p.get('redirect_uri')) return res(400, { error: 'invalid_grant' });
      const challenge = b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest());
      if (challenge !== c.challenge) return res(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      const refresh = 'refresh-' + crypto.randomBytes(4).toString('hex');
      this.refreshTokens.add(refresh);
      const idToken = ['x', Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url'), 'y'].join('.');
      return res(200, { ...this.access(), refresh_token: refresh, id_token: idToken, scope: this.grantScope });
    }
    if (p.get('grant_type') === 'refresh_token') {
      if (!this.refreshTokens.has(p.get('refresh_token'))) return res(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return res(200, this.access());
    }
    return res(400, { error: 'unsupported_grant_type' });
  }

  access() {
    const t = 'access-' + ++this.tokenSeq;
    this.valid.add(t);
    return { access_token: t, expires_in: 3599, token_type: 'Bearer' };
  }
}

function pad(v) { const r = v.slice(); while (r.length < COLS) r.push(''); return r; }
function trimRow(r) { const x = r.slice(); while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop(); return x; }
function checkCols(a, b) { if (a < 0 || b > 16) throw new Error('자동 계산 열(Q~S) 또는 범위 밖에 쓰려고 했습니다'); }
function res(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

/**
 * 지어낸 장부. 실제 장부와 같은 모양: 연도 머리줄 → 월 머리줄 → 작업 행, 월마다 행 묶음.
 * 2025년: 빈 행 없음 / 2026년: 1월은 작업 1건뿐(빈 행 없음), 2~11월은 빈 행 2개 / 2027년: 빈 행만.
 */
function fixture() {
  const rows = [];
  const groups = [];
  const DATE = 'yyyy-mm-dd';
  const push = (v, f) => rows.push({ v, f: f || {} });
  const job = (date, client, director, pd, title, amount, o = {}) => push([
    isoToSerial(date), client, director, pd, title, amount, o.type || '', o.quote || '', o.invoice || '', o.paid || '',
    o.paidAmount ?? '', o.paidDate ? isoToSerial(o.paidDate) : '', '', o.note || '', '', o.attrYear ?? ''], { 0: DATE, 11: DATE, validation: 'job' });
  const emptyJobRow = () => push([], { 0: DATE, 11: DATE, validation: 'job' });
  const done = { invoice: '완료', paid: '완료' };
  const clients = ['오로라 필름', '모노 스튜디오', '하늘 프로덕션', '블루도트'];
  let yearStart = null;
  const openYear = (label) => { closeYear(); push([label, '', '(합계 수식)']); yearStart = rows.length; };
  const closeYear = () => { if (yearStart !== null) groups.push({ start: yearStart, end: rows.length, depth: 1 }); yearStart = null; };
  const month = (label, fill) => { push([label, '', '(합계 수식)']); const s = rows.length; fill(); if (rows.length > s) groups.push({ start: s, end: rows.length, depth: 2 }); };

  push(['납품일', '거래처', '감독', 'PD', '내용', '견적금액', '구분', '견적서', '계산서', '지급', '입금액', '입금일', '인센티브', '비고', '원본 추가정보', '귀속연도(필요시)']);

  openYear('2025년');
  month('기타 (2024 납품)', () => job('2024-12-20', '오로라 필름', '한지우', '', '브랜드 필름', 3000000, { attrYear: 2025 }));
  const y25 = [[4, 5, 3], [6, 2, 4, 3], [5, 5], [3, 4, 6], [2, 8], [7, 3], [4, 4, 2], [5, 3], [6, 6], [3, 5, 4], [8, 2], [5, 4, 3]];
  y25.forEach((amts, m) => month(`${m + 1}월`, () => amts.forEach((a, k) => job(
    `2025-${String(m + 1).padStart(2, '0')}-${String(5 + k * 7).padStart(2, '0')}`,
    clients[(m + k) % 4], '감독' + ((m + k) % 3 + 1), '', `25년 ${m + 1}월 작업 ${k + 1}`, a * 1000000, done))));

  openYear('2026년');
  const y26 = [[2], [8, 4, 2.5], [2, 3, 1.5], [1.5, 4, 2.5, 0], [3, 1, 2], [3, 4, 2], [5, 1.5], [36, 6, 12, 4], [8, 6, 1.2], [3, 2, 4, 6], [1, 3]];
  y26.forEach((amts, m) => month(`${m + 1}월`, () => {
    amts.forEach((a, k) => {
      const date = `2026-${String(m + 1).padStart(2, '0')}-${String(3 + k * 6).padStart(2, '0')}`;
      const o = a === 0 ? { type: '서비스', ...done }
        : m >= 9 ? {}
        : m >= 7 && k % 2 === 0 ? { invoice: '완료' }
        : done;
      job(date, clients[(m + k) % 4], '감독' + ((m + k) % 3 + 1), k % 2 ? '피디' + (k + 1) : '', `26년 ${m + 1}월 작업 ${k + 1}`, a * 1000000, o);
    });
    if (m > 0) { emptyJobRow(); emptyJobRow(); }
  }));
  month('12월', () => { emptyJobRow(); emptyJobRow(); });

  openYear('2027년');
  for (let m = 1; m <= 12; m++) month(`${m}월`, () => emptyJobRow());
  closeYear();
  return new FakeGoogle({ rows, groups });
}

const CLIENT_JSON = JSON.stringify({ installed: { client_id: 'fake-client.apps.googleusercontent.com', client_secret: 'fake-secret', redirect_uris: ['http://localhost'] } });

/** 메모리 저장소(Store 와 같은 모양). */
function memoryStore(init = {}) {
  let config = { ...init };
  let token = init.token || null;
  return {
    get: () => config,
    set: (p) => { config = { ...config, ...p }; },
    getToken: () => token,
    setToken: (t) => { token = t || null; },
  };
}

module.exports = { FakeGoogle, fixture, memoryStore, CLIENT_JSON, ID, SHEET_ID };
