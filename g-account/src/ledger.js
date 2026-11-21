'use strict';
/** 화면이 부르는 일: 읽기·등록·수정·삭제, 부가세 기준 바꾸기, 다음 해 묶음 만들기. */

const core = require('./core');

class NoBlockError extends core.UserError {
  constructor(year, month) {
    super(`장부에 ${year}년 ${month}월 묶음이 없습니다. 시트에 그 달 묶음을 먼저 만들어 주세요.`);
    this.year = year;
  }
}

const MAX_AUTO_YEARS = 3; // 한 번에 자동으로 만드는 연도 수 상한

class Ledger {
  /**
   * @param {import('./sheets').SheetsClient} client
   * @param {{ today?: () => string, dismissed?: () => string[] }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.today = opts.today || (() => core.localToday());
    this.dismissed = opts.dismissed || (() => []);
    this.queue = Promise.resolve(); // 쓰기는 한 번에 하나씩
    this.autoDone = false;
    this.notice = '';
  }

  async read() {
    const meta = await this.client.meta(core.SHEET_TITLE, core.VAT_SHEET_TITLE);
    const ranges = [`'${core.SHEET_TITLE}'!A1:P${meta.rowCount}`];
    if (meta.vatSheetId !== null) ranges.push(`'${core.VAT_SHEET_TITLE}'!${core.VAT_BASIS_CELL}`);
    const [values, basisCell] = await this.client.valuesBatch(ranges);
    const basis = basisCell && basisCell[0] && basisCell[0][0] === core.VAT_INCLUDED ? core.VAT_INCLUDED : core.VAT_EXCLUDED;
    return { meta, parsed: core.parseSheet(values, meta.rowCount), basis };
  }

  snapshot({ meta, parsed, basis }) {
    const today = this.today();
    const hidden = new Set(this.dismissed());
    const checks = core.checkLedger(parsed.jobs, today);
    const lastYear = Math.max(0, ...parsed.years.map((y) => y.year));
    const notice = this.notice;
    this.notice = '';
    return {
      jobs: parsed.jobs,
      today,
      title: meta.title,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${this.client.id}/edit#gid=${meta.sheetId}`,
      vat: { basis, hasSheet: meta.vatSheetId !== null },
      checks: checks.filter((c) => !hidden.has(c.key)),
      hiddenChecks: checks.filter((c) => hidden.has(c.key)).length,
      years: { last: lastYear, next: lastYear + 1 },
      notice,
    };
  }

  /** 읽어서 돌려줍니다. 앱을 켠 뒤 처음 읽을 때 필요한 연도 묶음을 자동으로 만듭니다. */
  async getData() {
    if (!this.autoDone) {
      this.autoDone = true;
      await this.autoYears();
    }
    return this.snapshot(await this.read());
  }

  /**
   * 올해 묶음이 없거나, 11월 이후인데 다음 해 묶음이 없으면 만듭니다.
   * 마지막 연도 바로 다음 해부터 차례로, 한 번에 최대 3년까지만 만듭니다.
   */
  async autoYears() {
    const today = this.today();
    const y = Number(today.slice(0, 4));
    const target = Number(today.slice(5, 7)) >= 11 ? y + 1 : y;
    const made = [];
    for (let i = 0; i < MAX_AUTO_YEARS; i++) {
      const { parsed } = await this.read();
      const last = Math.max(0, ...parsed.years.map((x) => x.year));
      if (!last || last >= target) break;
      await this.createYear(last + 1);
      made.push(last + 1);
    }
    if (made.length) this.notice = `시트에 ${made.join('·')}년 묶음을 만들었습니다.`;
  }

  /** 읽고 → 요청을 만들고 → 한 번에 적용한 뒤 → 다시 읽어 돌려줍니다. */
  write(plan) {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const requests = await plan(state);
      if (requests.length) await this.client.batchUpdate(requests);
      return this.snapshot(await this.read());
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** 새 작업을 납품일이 속한 연도·월 묶음에 넣습니다. 다음 해 묶음이 아직 없으면 만들고 넣습니다. */
  async addJob(job) {
    const clean = core.cleanJob(job, true);
    const add = () => this.write(({ meta, parsed }) => newRowRequests(meta.sheetId, parsed, clean));
    try {
      return await add();
    } catch (e) {
      if (!(e instanceof NoBlockError)) throw e;
      const { parsed } = await this.read();
      const last = Math.max(0, ...parsed.years.map((x) => x.year));
      if (e.year !== last + 1) throw e; // 몇 년 뒤(오타일 수 있음)는 만들지 않습니다.
      await this.createYear(e.year);
      this.notice = `시트에 ${e.year}년 묶음을 만들었습니다.`;
      return add();
    }
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

  /** 시트 「부가세」 탭의 견적금액 기준(부가세 별도/포함)을 바꿉니다. */
  setVatBasis(basis) {
    if (basis !== core.VAT_INCLUDED && basis !== core.VAT_EXCLUDED) throw new core.UserError('부가세 기준은 「부가세 별도」 또는 「부가세 포함」입니다.');
    return this.write(({ meta }) => {
      if (meta.vatSheetId === null) throw new core.UserError(`시트에 「${core.VAT_SHEET_TITLE}」 탭이 없습니다.`);
      return [{
        updateCells: {
          start: { sheetId: meta.vatSheetId, rowIndex: 4, columnIndex: 1 },
          rows: [{ values: [{ userEnteredValue: { stringValue: basis } }] }],
          fields: 'userEnteredValue',
        },
      }];
    });
  }

  /** 다음 해 묶음을 지금 만듭니다(설정 창의 버튼). */
  async createNextYear() {
    const { parsed } = await this.read();
    const next = Math.max(0, ...parsed.years.map((x) => x.year)) + 1;
    await this.createYear(next);
    this.notice = `시트에 ${next}년 묶음을 만들었습니다.`;
    return this.snapshot(await this.read());
  }

  /** year 묶음을 마지막 연도 묶음 바로 아래에 만듭니다. year 는 마지막 연도 + 1 이어야 합니다. */
  createYear(year) {
    const run = this.queue.then(async () => {
      const { meta, parsed } = await this.read();
      const last = parsed.years.reduce((a, b) => (b.year > a.year ? b : a), { year: 0 });
      if (year !== last.year + 1) throw new core.UserError(`${year}년 묶음은 ${last.year}년 다음 해가 아니라서 만들지 않았습니다.`);

      // 마지막 연도의 행 묶음: 첫 월 머리줄부터 시작하는 1단계 묶음
      const group = meta.rowGroups.find((g) => g.depth === 1 && g.start === last.header);
      if (!group) throw new core.UserError(`${last.year}년 행 묶음을 찾지 못해 ${year}년 묶음을 만들지 않았습니다. 시트에서 ${last.year}년 묶음(+/− 버튼)이 있는지 확인해 주세요.`);
      const january = parsed.blocks.find((b) => b.year === last.year && b.month === 1);
      if (!january || january.last < january.first) throw new core.UserError(`${last.year}년 1월 묶음을 본뜰 수 없어 ${year}년 묶음을 만들지 않았습니다.`);

      const start = group.end + 1;
      const size = 1 + 12 + [...Array(12)].reduce((a, _, i) => a + core.MONTH_ROWS(i + 1), 0);
      for (let r = start; r < start + size; r++) {
        const k = parsed.kinds[r];
        if (k && k !== 'empty') throw new core.UserError(`${last.year}년 묶음 아래 ${r}행에 내용이 있어 ${year}년 묶음을 만들지 않았습니다. 그 아래를 비워 주세요.`);
      }
      if (meta.rowGroups.some((g) => g.end > start - 1 && g.start < start - 1 + size)) {
        throw new core.UserError(`${last.year}년 묶음 아래에 다른 행 묶음이 있어 ${year}년 묶음을 만들지 않았습니다.`);
      }

      const [yearCells, monthCells] = (await this.client.valuesBatch([
        `'${core.SHEET_TITLE}'!A${last.header}:P${last.header}`,
        `'${core.SHEET_TITLE}'!A${january.header}:P${january.header}`,
      ], 'FORMULA')).map((v) => v[0] || []);

      const { requests } = core.yearBlockRequests({
        sheetId: meta.sheetId, year, fromYear: last.year, start,
        rowCount: meta.rowCount, columnCount: meta.columnCount,
        templates: { yearRow: last.header, monthRow: january.header, jobRow: january.first, yearCells, monthCells },
      });
      await this.client.batchUpdate(requests);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function newRowRequests(sheetId, parsed, job) {
  let slot;
  try {
    slot = core.planSlot(parsed, job.date);
  } catch (e) {
    if (/묶음이 없습니다/.test(e.message)) throw new NoBlockError(Number(job.date.slice(0, 4)), Number(job.date.slice(5, 7)));
    throw e;
  }
  return [
    ...(slot.insert ? [core.insertRowRequest(sheetId, slot.row)] : []),
    ...core.writeRowRequests(sheetId, slot.row, job),
  ];
}

module.exports = { Ledger };
