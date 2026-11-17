'use strict';
const { Service } = require('../src/service');
const { fixture, memoryStore, CLIENT_JSON, ID } = require('./fake-google');

const TODAY = '2026-11-17';

/** 가짜 구글에 연결된 Service. ready=true 면 클라이언트·로그인·시트 연결까지 마친 상태입니다. */
function makeService({ ready = true, google = fixture() } = {}) {
  const store = memoryStore();
  if (ready) {
    google.refreshTokens.add('refresh-ready');
    store.set({ client: { id: 'fake-client.apps.googleusercontent.com', secret: 'fake-secret' }, spreadsheetId: ID, spreadsheetTitle: '가짜 매출 장부', email: 'owner@example.com' });
    store.setToken('refresh-ready');
  }
  const opened = [];
  const service = new Service({
    store,
    fetch: google.fetch,
    today: () => TODAY,
    openExternal: (url) => { opened.push(url); setImmediate(() => google.approve(url, { deny: service.denyNext })); },
    pickFile: async () => service.nextFile === undefined ? CLIENT_JSON : service.nextFile,
    log: () => {},
  });
  return { service, google, store, opened };
}

/** run() 결과에서 ok 를 꺼내고, 오류면 예외로 바꿉니다. */
async function ok(service, name, args) {
  const r = await service.run(name, args);
  if ('err' in r) throw new Error(r.err);
  return r.ok;
}

const expectOf = (j) => ({ date: j.date, client: j.client, title: j.title, amount: j.amount });

module.exports = { makeService, ok, expectOf, TODAY };
