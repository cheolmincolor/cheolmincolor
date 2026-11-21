'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeService, ok } = require('./helpers');
const { parseClientFile } = require('../src/auth');
const { Store } = require('../src/store');
const { ID } = require('./fake-google');

test('처음 설정: 클라이언트 파일 → 브라우저 로그인(PKCE) → 시트 연결', async () => {
  const { service, google, store, opened } = makeService({ ready: false });
  let st = await ok(service, 'status');
  assert.deepEqual([st.hasClient, st.signedIn, st.spreadsheetId], [false, false, '']);

  st = await ok(service, 'pickClient');
  assert.equal(st.hasClient, true);

  st = await ok(service, 'signIn'); // 실제로 127.0.0.1 에 임시 주소를 열고, 가짜 구글이 그 주소로 코드를 보냅니다.
  assert.deepEqual([st.signedIn, st.email], [true, 'owner@example.com']);
  const auth = new URL(opened[0]);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(auth.searchParams.get('scope'), /auth\/spreadsheets/);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.ok(store.getToken().startsWith('refresh-'));

  assert.match((await service.run('setSheet', ['https://example.com/x'])).err, /시트 주소가 아닙니다/);
  assert.match((await service.run('setSheet', ['https://docs.google.com/spreadsheets/d/OTHER_SPREADSHEET_ID_00000/edit'])).err, /찾을 수 없습니다/);
  google.sheetTitle = '시트1';
  assert.match((await service.run('setSheet', [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`])).err, /「장부」 시트가 없습니다/);
  delete google.sheetTitle;
  st = await ok(service, 'setSheet', [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`]);
  assert.deepEqual([st.spreadsheetId, st.spreadsheetTitle], [ID, '가짜 매출 장부']);
  assert.equal((await ok(service, 'getData')).jobs.length > 0, true);
});

test('로그인 취소·권한 체크 해제는 알아들을 수 있게 알림', async () => {
  const { service, google, store } = makeService({ ready: false });
  await ok(service, 'pickClient');
  service.denyNext = true;
  assert.match((await service.run('signIn')).err, /취소/);
  service.denyNext = false;
  google.grantScope = 'openid email'; // 동의 화면에서 스프레드시트 항목 체크를 뺀 경우
  assert.match((await service.run('signIn')).err, /스프레드시트 권한/);
  assert.equal(store.getToken(), null);
});

test('잘못된 클라이언트 파일', async () => {
  assert.throws(() => parseClientFile('not json'), /JSON 파일이 아닙니다/);
  assert.throws(() => parseClientFile('{"web":{"client_id":"a","client_secret":"b"}}'), /데스크톱 앱/);
  assert.throws(() => parseClientFile('{"foo":1}'), /OAuth 클라이언트 파일이 아닙니다/);
  const { service } = makeService({ ready: false });
  service.nextFile = '{"web":{"client_id":"a","client_secret":"b"}}';
  assert.match((await service.run('pickClient')).err, /데스크톱 앱/);
  service.nextFile = null; // 파일 고르기를 취소
  assert.equal((await ok(service, 'pickClient')).hasClient, false);
});

test('토큰: 만료되면 새로 받아 다시 시도, 취소됐으면 로그인 화면으로', async () => {
  const { service, google, store } = makeService();
  await ok(service, 'getData');
  google.expireTokens(); // 짧은 토큰 만료 → 401 → 새 토큰으로 한 번 더
  await ok(service, 'getData');
  google.refreshTokens.clear(); // 구글 계정에서 앱 접근을 취소한 경우
  google.expireTokens();
  const r = await service.run('getData');
  assert.equal(r.auth, true);
  assert.match(r.err, /다시 로그인/);
  assert.equal(store.getToken(), null);
  assert.equal((await ok(service, 'status')).signedIn, false);
});

test('로그아웃은 구글에 토큰 취소를 알리고, 처음부터 다시는 연결을 모두 지움', async () => {
  const { service, google, store } = makeService();
  await ok(service, 'signOut');
  assert.equal(google.refreshTokens.has('refresh-ready'), false);
  assert.ok(google.calls.some((c) => c.url === 'https://oauth2.googleapis.com/revoke'));
  const st = await ok(service, 'reset');
  assert.deepEqual([st.hasClient, st.signedIn, st.spreadsheetId], [false, false, '']);
  assert.equal(store.get().client, null);
});

test('저장소: 토큰은 암호화해서만 디스크에 씀', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-store-'));
  const cipher = { available: () => true, encrypt: (s) => Buffer.from('ENC:' + s), decrypt: (b) => b.toString().slice(4) };
  const a = new Store(dir, cipher);
  a.set({ spreadsheetId: 'X' });
  a.setToken('secret-refresh');
  assert.equal(fs.readFileSync(path.join(dir, 'token.bin'), 'utf8'), 'ENC:secret-refresh');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), /secret-refresh/);
  const b = new Store(dir, cipher);
  assert.deepEqual([b.get().spreadsheetId, b.getToken()], ['X', 'secret-refresh']);
  b.setToken(null);
  assert.equal(fs.existsSync(path.join(dir, 'token.bin')), false);

  const plain = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'gz-store-')), { available: () => false });
  plain.setToken('t');
  assert.equal(plain.getToken(), 't'); // 앱을 켜 둔 동안만 기억
  assert.equal(fs.existsSync(path.join(plain.dir, 'token.bin')), false);
});
