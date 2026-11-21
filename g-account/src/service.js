'use strict';
/**
 * 화면(renderer)이 부를 수 있는 일을 모아 둔 곳. Electron 과 무관하게 만들어 테스트에서도 그대로 씁니다.
 * 모든 결과는 { ok } 또는 { err, auth } 로 돌려줍니다(auth=true 면 로그인이 필요하다는 뜻).
 */

const { Auth, parseClientFile } = require('./auth');
const { SheetsClient, AuthError, parseSpreadsheetId } = require('./sheets');
const { Ledger } = require('./ledger');
const { UserError, SHEET_TITLE } = require('./core');

const LEDGER_CALLS = new Set(['getData', 'addJob', 'updateJob', 'deleteJob', 'setVatBasis', 'createNextYear']);

class Service {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {(url: string) => any} o.openExternal
   * @param {() => Promise<string|null>} o.pickFile  파일 고르기 창. 고른 파일의 내용(취소면 null).
   * @param {typeof fetch} [o.fetch]
   * @param {() => string} [o.today]
   * @param {(e: Error) => void} [o.log]
   * @param {import('./updater').Updater} [o.updater]
   * @param {() => void} [o.quit]  업데이트를 설치할 때 앱을 끝냅니다.
   */
  constructor(o) {
    this.o = o;
    this.store = o.store;
    this.auth = new Auth({ store: o.store, openExternal: o.openExternal, fetch: o.fetch });
    this.ledger = null;
  }

  client(spreadsheetId) {
    return new SheetsClient({ spreadsheetId, getToken: (force) => this.auth.getAccessToken(force), fetch: this.o.fetch });
  }

  getLedger() {
    const id = this.store.get().spreadsheetId;
    if (!id) throw new UserError('매출 장부 시트를 먼저 연결해 주세요.');
    if (!this.ledger || this.ledger.client.id !== id) {
      this.ledger = new Ledger(this.client(id), { today: this.o.today, dismissed: () => this.store.get().dismissed || [] });
    }
    return this.ledger;
  }

  status() {
    const c = this.store.get();
    return {
      hasClient: !!this.auth.client,
      signedIn: this.auth.signedIn,
      email: c.email || '',
      spreadsheetId: c.spreadsheetId || '',
      spreadsheetTitle: c.spreadsheetTitle || '',
    };
  }

  /** 이름으로 일을 실행하고, 오류를 화면에 보여 줄 문장으로 바꿉니다. */
  async run(name, args = []) {
    try {
      return { ok: await this.dispatch(name, Array.isArray(args) ? args : []) };
    } catch (e) {
      if (!(e instanceof UserError) && this.o.log) this.o.log(e);
      return { err: e instanceof UserError ? e.message : '예상하지 못한 오류: ' + e.message, auth: e instanceof AuthError };
    }
  }

  async dispatch(name, args) {
    if (LEDGER_CALLS.has(name)) return this.getLedger()[name](...args);
    switch (name) {
      case 'status':
        return this.status();
      case 'pickClient': {
        const text = await this.o.pickFile();
        if (text == null) return this.status();
        this.auth.setClient(parseClientFile(text));
        return this.status();
      }
      case 'signIn':
        await this.auth.signIn();
        return this.status();
      case 'signOut':
        await this.auth.signOut();
        return this.status();
      case 'setSheet': {
        const id = parseSpreadsheetId(args[0]);
        if (!id) throw new UserError('시트 주소가 아닙니다. 브라우저 주소창의 https://docs.google.com/spreadsheets/d/… 주소를 그대로 붙여 넣어 주세요.');
        const meta = await this.client(id).meta(SHEET_TITLE); // 열 수 있고 「장부」 탭이 있는지 확인
        this.store.set({ spreadsheetId: id, spreadsheetTitle: meta.title, dismissed: [] });
        this.ledger = null;
        return this.status();
      }
      case 'dismissCheck': {
        // 점검 목록에서 「문제없음」으로 숨긴 항목. 행 내용이 바뀌면 다시 보입니다.
        const key = String(args[0] || '');
        if (!key) throw new UserError('숨길 항목이 없습니다.');
        const list = new Set(this.store.get().dismissed || []);
        list.add(key);
        this.store.set({ dismissed: [...list].slice(-500) });
        return this.getLedger().getData();
      }
      case 'resetChecks':
        this.store.set({ dismissed: [] });
        return this.getLedger().getData();
      case 'update:status':
        return this.o.updater ? this.o.updater.state : { status: 'unsupported', current: '', error: '' };
      case 'update:check':
        if (!this.o.updater) throw new UserError('업데이트를 확인할 수 없습니다.');
        return this.o.updater.check({ download: true });
      case 'update:install':
        if (!this.o.updater) throw new UserError('업데이트를 설치할 수 없습니다.');
        try { this.o.updater.install({ relaunch: true }); } catch (e) { throw new UserError(e.message); }
        if (this.o.quit) this.o.quit();
        return this.o.updater.state;
      case 'reset':
        await this.auth.signOut();
        this.store.set({ client: null, spreadsheetId: '', spreadsheetTitle: '' });
        this.ledger = null;
        return this.status();
      default:
        throw new UserError('알 수 없는 요청: ' + name);
    }
  }
}

module.exports = { Service };
