'use strict';
/**
 * 구글 로그인 (데스크톱 앱용 OAuth: 브라우저 + 이 컴퓨터 안의 임시 주소 + PKCE).
 *
 * 1. 이 컴퓨터(127.0.0.1)에 임시 주소를 열고, 기본 브라우저로 구글 로그인 화면을 엽니다.
 * 2. 사용자가 허용하면 구글이 그 임시 주소로 일회용 코드를 보내고, 앱이 코드를 토큰으로 바꿉니다.
 * 3. 오래 쓰는 토큰(refresh token)만 저장하고, 시트를 부를 때마다 짧은 토큰을 새로 받습니다.
 */

const http = require('http');
const crypto = require('crypto');
const { AuthError } = require('./sheets');
const { UserError } = require('./core');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SCOPES = ['openid', 'email', SHEETS_SCOPE];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Google Cloud 콘솔에서 받은 OAuth 클라이언트 JSON 을 검사합니다. */
function parseClientFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new UserError('JSON 파일이 아닙니다. Google Cloud 콘솔에서 받은 client_secret_….json 파일을 골라 주세요.'); }
  if (data && data.web) throw new UserError('「웹 애플리케이션」 유형의 클라이언트입니다. 유형을 「데스크톱 앱」으로 새로 만들어 주세요.');
  const c = data && data.installed;
  if (!c || !c.client_id || !c.client_secret) throw new UserError('OAuth 클라이언트 파일이 아닙니다. 「데스크톱 앱」 유형 클라이언트의 JSON 을 내려받아 골라 주세요.');
  return { id: c.client_id, secret: c.client_secret };
}

function emailFromIdToken(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).email || ''; } catch { return ''; }
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#f4f4f2;color:#0b0b0b">
<div style="text-align:center"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#52514e;margin:0">${body}</p></div>`;

class Auth {
  /**
   * @param {object} o
   * @param {{ get(): object, set(patch: object): void, getToken(): string|null, setToken(t: string|null): void }} o.store
   * @param {(url: string) => any} o.openExternal  기본 브라우저로 주소를 엽니다.
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ store, openExternal, fetch: f }) {
    this.store = store;
    this.openExternal = openExternal;
    this.fetch = f || fetch;
    this.access = null; // { token, expires }
    this.pending = null;
  }

  get client() { return this.store.get().client || null; }
  get signedIn() { return !!this.store.getToken(); }

  setClient(client) {
    this.store.set({ client, email: '' });
    this.store.setToken(null);
    this.access = null;
  }

  async post(url, params) {
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    } catch {
      throw new UserError('구글에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
    const data = await res.json().catch(() => ({}));
    if (data.error && typeof data.error === 'object') data.error = data.error.status || data.error.message || 'error';
    return { ok: res.ok, data };
  }

  /** 브라우저로 로그인하고 토큰을 저장합니다. 로그인한 이메일을 돌려줍니다. */
  async signIn() {
    const client = this.client;
    if (!client) throw new UserError('먼저 OAuth 클라이언트 파일을 골라 주세요.');
    if (this.pending) this.pending.cancel();

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let timer;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/') { res.writeHead(404).end(); return; }
        const send = (status, title, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(title, body)); };
        if (url.searchParams.get('state') !== state) { send(400, '잘못된 요청', '앱에서 로그인을 다시 시작해 주세요.'); return; }
        const error = url.searchParams.get('error');
        if (error) {
          send(200, '로그인을 취소했습니다', '이 창을 닫고 앱에서 다시 시도해 주세요.');
          finish(new UserError(error === 'access_denied' ? '구글 로그인을 취소했습니다.' : '구글 로그인 오류: ' + error));
          return;
        }
        send(200, '로그인했습니다', '이 창을 닫고 GRAYZONE 장부 앱으로 돌아가세요.');
        finish(null, url.searchParams.get('code'));
      });
      const finish = (err, code) => {
        clearTimeout(timer);
        server.close();
        this.pending = null;
        if (err) reject(err); else resolve({ code, redirectUri });
      };
      let redirectUri;
      server.on('error', (e) => finish(new UserError('로그인용 임시 주소를 열지 못했습니다: ' + e.message)));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const url = AUTH_URL + '?' + new URLSearchParams({
          client_id: client.id,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        Promise.resolve(this.openExternal(url)).catch((e) => finish(new UserError('브라우저를 열지 못했습니다: ' + e.message)));
      });
      timer = setTimeout(() => finish(new UserError('로그인 시간이 지났습니다(5분). 다시 시도해 주세요.')), LOGIN_TIMEOUT_MS);
      this.pending = { cancel: () => finish(new UserError('로그인을 다시 시작했습니다.')) };
    });

    const { ok, data } = await this.post(TOKEN_URL, {
      client_id: client.id,
      client_secret: client.secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (!ok) throw new UserError('로그인 토큰을 받지 못했습니다: ' + (data.error_description || data.error || '알 수 없는 오류'));
    if (!String(data.scope || '').split(' ').includes(SHEETS_SCOPE)) {
      throw new UserError('스프레드시트 권한이 허용되지 않았습니다. 다시 로그인하면서 「Google 스프레드시트… 보기, 수정…」 항목에 체크해 주세요.');
    }
    if (!data.refresh_token) throw new UserError('구글이 로그인 정보를 보내지 않았습니다. 다시 시도해 주세요.');

    const email = emailFromIdToken(data.id_token || '');
    this.store.setToken(data.refresh_token);
    this.store.set({ email });
    this.access = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
    return email;
  }

  /** 시트를 부를 때 쓰는 짧은 토큰. 만료가 1분 안 남았거나 force 면 새로 받습니다. */
  async getAccessToken(force = false) {
    if (!force && this.access && this.access.expires - Date.now() > 60000) return this.access.token;
    const refresh = this.store.getToken();
    const client = this.client;
    if (!refresh || !client) throw new AuthError('구글 로그인이 필요합니다.');
    const { ok, data } = await this.post(TOKEN_URL, {
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    if (!ok) {
      if (data.error === 'invalid_grant' || data.error === 'invalid_client' || data.error === 'unauthorized_client') {
        this.store.setToken(null);
        this.access = null;
        throw new AuthError('구글 로그인이 만료되었습니다. 다시 로그인해 주세요.');
      }
      throw new UserError('구글 로그인 확인 중 오류: ' + (data.error_description || data.error || '알 수 없는 오류'));
    }
    this.access = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
    return this.access.token;
  }

  /** 로그아웃: 구글에도 토큰 취소를 알리고 저장한 토큰을 지웁니다. */
  async signOut() {
    const refresh = this.store.getToken();
    this.store.setToken(null);
    this.store.set({ email: '' });
    this.access = null;
    if (refresh) await this.post(REVOKE_URL, { token: refresh }).catch(() => {});
  }
}

module.exports = { Auth, parseClientFile, SCOPES, SHEETS_SCOPE };
