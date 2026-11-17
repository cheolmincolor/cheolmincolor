'use strict';
/** Google Sheets API(v4) 를 직접 부르는 작은 클라이언트. */

const { UserError } = require('./core');

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';

/** 로그인이 필요하다는 뜻의 오류. 화면은 이 오류를 받으면 로그인 단계를 보여 줍니다. */
class AuthError extends UserError {}

/** 시트 주소나 ID 에서 ID 만 꺼냅니다. */
function parseSpreadsheetId(text) {
  const s = String(text || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

class SheetsClient {
  /**
   * @param {object} o
   * @param {string} o.spreadsheetId
   * @param {(force?: boolean) => Promise<string>} o.getToken  액세스 토큰. force=true 면 새로 받습니다.
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ spreadsheetId, getToken, fetch: f }) {
    this.id = spreadsheetId;
    this.getToken = getToken;
    this.fetch = f || fetch;
  }

  async request(method, path, body) {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(attempt > 0);
      try {
        res = await this.fetch(API + encodeURIComponent(this.id) + path, {
          method,
          headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new UserError('구글 시트에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
      }
      if (res.status !== 401) break; // 토큰이 만료됐으면 한 번 새로 받아 다시 시도합니다.
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* 아래에서 상태 코드로 처리 */ }
    if (res.ok) return data;

    const msg = (data.error && data.error.message) || text.slice(0, 200);
    if (res.status === 401) throw new AuthError('구글 로그인이 만료되었습니다. 다시 로그인해 주세요.');
    if (res.status === 403 && /scope/i.test(msg)) throw new AuthError('시트 접근 권한이 없습니다. 다시 로그인하면서 「스프레드시트 보기·수정」을 허용해 주세요.');
    if (res.status === 403) throw new UserError('이 시트를 열 권한이 없습니다. 로그인한 구글 계정이 시트의 소유자 또는 편집자인지 확인해 주세요.');
    if (res.status === 404) throw new UserError('시트를 찾을 수 없습니다. 설정에서 시트 주소를 확인해 주세요.');
    if (res.status === 429) throw new UserError('요청이 너무 많습니다. 잠시 후 다시 해 주세요.');
    throw new UserError(`구글 시트 오류 (${res.status}): ${msg}`);
  }

  /** 스프레드시트 제목과 「장부」 시트의 ID·행 수. */
  async meta(title) {
    const d = await this.request('GET', '?fields=' + encodeURIComponent('properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)'));
    const sheet = (d.sheets || []).map((s) => s.properties).find((p) => p.title === title);
    if (!sheet) throw new UserError(`「${d.properties.title}」에 「${title}」 시트가 없습니다. 매출 장부 시트 주소인지 확인해 주세요.`);
    return { title: d.properties.title, sheetId: sheet.sheetId, rowCount: sheet.gridProperties.rowCount };
  }

  /** 서식 없이 값만 읽습니다. 날짜는 일수(serial)로 옵니다. */
  async values(range) {
    const q = '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';
    const d = await this.request('GET', '/values/' + encodeURIComponent(range) + q);
    return d.values || [];
  }

  /** 여러 변경을 한 번에 적용합니다. 하나라도 실패하면 아무것도 바뀌지 않습니다. */
  batchUpdate(requests) {
    return this.request('POST', ':batchUpdate', { requests });
  }
}

module.exports = { SheetsClient, AuthError, parseSpreadsheetId };
