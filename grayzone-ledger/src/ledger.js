'use strict';
/** 화면이 부르는 네 가지 일: 읽기·등록·수정·삭제. */

const core = require('./core');

class Ledger {
  /**
   * @param {import('./sheets').SheetsClient} client
   * @param {{ today?: () => string }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.today = opts.today || (() => core.localToday());
    this.queue = Promise.resolve(); // 쓰기는 한 번에 하나씩
  }

  async read() {
    const meta = await this.client.meta(core.SHEET_TITLE);
    const values = await this.client.values(`'${core.SHEET_TITLE}'!A1:P${meta.rowCount}`);
    return { meta, parsed: core.parseSheet(values, meta.rowCount) };
  }

  snapshot({ meta, parsed }) {
    return {
      jobs: parsed.jobs,
      today: this.today(),
      title: meta.title,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${this.client.id}/edit#gid=${meta.sheetId}`,
    };
  }

  async getData() {
    return this.snapshot(await this.read());
  }

  /** 읽고 → 요청을 만들고 → 한 번에 적용한 뒤 → 다시 읽어 돌려줍니다. */
  write(plan) {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const requests = plan(state);
      if (requests.length) await this.client.batchUpdate(requests);
      return this.getData();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 새 작업을 납품일이 속한 연도·월 묶음에 넣습니다. */
  addJob(job) {
    const clean = core.cleanJob(job, true);
    return this.write(({ meta, parsed }) => newRowRequests(meta.sheetId, parsed, clean));
  }

  /** 한 행을 고칩니다. patch 에 있는 항목만 바뀝니다. expect 는 앱이 보던 행 내용입니다. */
  updateJob(row, expect, patch) {
    const clean = core.cleanJob(patch, false);
    return this.write(({ meta, parsed }) => {
      const current = core.findJob(parsed, row, expect);
      const merged = {};
      for (const f of core.FIELDS) merged[f] = f in clean ? clean[f] : current[f];
      if (!merged.date || !merged.client || !merged.title) {
        throw new core.UserError('납품일·거래처·내용은 비울 수 없습니다.');
      }
      const moved = 'date' in clean && core.isIsoDate(current.date) &&
        clean.date.slice(0, 7) !== current.date.slice(0, 7);
      if (!moved) return core.patchCellsRequests(meta.sheetId, row, clean);

      // 다른 달로 옮길 때: 원래 행을 비우고 새 달 묶음에 씁니다. 비우는 일을 먼저 해 두면
      // 위쪽에 행이 삽입되어도 엉뚱한 행을 비우지 않습니다.
      return [core.clearRowRequest(meta.sheetId, row), ...newRowRequests(meta.sheetId, parsed, merged)];
    });
  }

  /** 한 행의 입력 내용을 지웁니다. 빈 행은 다음 등록 때 다시 쓰입니다. */
  deleteJob(row, expect) {
    return this.write(({ meta, parsed }) => {
      core.findJob(parsed, row, expect);
      return [core.clearRowRequest(meta.sheetId, row)];
    });
  }
}

function newRowRequests(sheetId, parsed, job) {
  const slot = core.planSlot(parsed, job.date);
  return [
    ...(slot.insert ? [core.insertRowRequest(sheetId, slot.row)] : []),
    ...core.writeRowRequests(sheetId, slot.row, job),
  ];
}

module.exports = { Ledger };
