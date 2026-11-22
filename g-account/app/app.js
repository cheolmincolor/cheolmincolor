(function () {
'use strict';

var S = { jobs: [], today: '', sheetUrl: '', title: '', setup: false, status: null, vat: { basis: '부가세 별도', hasSheet: false }, checks: [], hiddenChecks: 0, years: null, update: { status: 'idle', current: '' }, year: null, tab: loadTab(), q: '', lf: 'all', open: loadOpen(), uf: 'all', us: 'new', loaded: false };
var $ = function (s, el) { return (el || document).querySelector(s); };
var app = $('#app'), modal = $('#modal'), toastEl = $('#toast');

// ---------- 도우미 ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function won(n) { return (Number(n) || 0).toLocaleString('ko-KR'); }
function man(n) { // 축 눈금용: 만원 단위
  var m = Math.round(n / 10000);
  return m >= 10000 ? (m / 10000).toLocaleString('ko-KR') + '억' : m.toLocaleString('ko-KR') + '만';
}
function num(v) { return typeof v === 'number' ? v : 0; }
function isIso(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function sum(list, f) { return list.reduce(function (a, j) { return a + f(j); }, 0); }
function digits(s) { var t = String(s == null ? '' : s).replace(/[^\d]/g, ''); return t === '' ? '' : Number(t); }
function daysSince(date) { return isIso(date) ? Math.round((Date.parse(S.today) - Date.parse(date)) / 86400000) : null; }
function expectOf(j) { return { date: j.date, client: j.client, title: j.title, amount: j.amount }; }
function people(j) { return [j.director && '감독 ' + j.director, j.pd && 'PD ' + j.pd].filter(Boolean).join(' · '); }
function needsInvoice(j) { return j.invoice !== '완료' && j.unpaid > 0; }
/** 부가세. 시트 「장부」 T~V열과 같은 규칙(src/core.js vatOf). */
function vatOf(amount) {
  if (typeof amount !== 'number') return { supply: 0, vat: 0, total: 0 };
  if (S.vat.basis === '부가세 포함') { var s = Math.round(amount / 1.1); return { supply: s, vat: amount - s, total: amount }; }
  var v = Math.floor(amount / 10);
  return { supply: amount, vat: v, total: amount + v };
}
function checksOf(j) { return S.checks.filter(function (c) { return c.row === j.row; }); }

// ---------- 서버 호출 ----------
var busy = 0;
function call(name, args) {
  if (!window.gz) return Promise.reject(new Error('이 화면은 G-Account 앱 안에서 열어야 동작합니다.'));
  busy++; document.body.classList.add('busy');
  return window.gz.call(name, args || []).then(function (r) {
    if (--busy === 0) document.body.classList.remove('busy');
    if (r && 'ok' in r) return r.ok;
    var e = new Error((r && r.err) || '알 수 없는 오류');
    e.auth = !!(r && r.auth);
    throw e;
  }, function (e) {
    if (--busy === 0) document.body.classList.remove('busy');
    throw e;
  });
}
function errText(e) { return String((e && e.message) || e).replace(/^(Error|Exception):\s*/, ''); }
function setData(d) {
  S.jobs = d.jobs; S.today = d.today; S.sheetUrl = d.sheetUrl; S.title = d.title; S.loaded = true; S.setup = false;
  S.vat = d.vat || { basis: '부가세 별도', hasSheet: false };
  S.checks = d.checks || []; S.hiddenChecks = d.hiddenChecks || 0; S.years = d.years || null;
  document.body.classList.remove('setup');
  if (S.year === null) S.year = Number(S.today.slice(0, 4));
  render();
  if (d.notice) toast(d.notice);
}
var firstPaint = false;
function load() {
  return call('status').then(function (st) {
    if (!st.hasClient || !st.signedIn || !st.spreadsheetId) return showSetup(st);
    return call('getData').then(setData);
  }).catch(function (e) {
    if (e.auth) return call('status').then(function (st) { showSetup(st, errText(e)); });
    if (!S.loaded) app.innerHTML = '<div class="empty"><div class="errbox">' + esc(errText(e)) + '</div><div class="btns" style="justify-content:center;margin-top:14px"><button class="btn" style="flex:0 0 auto" data-retry>다시 시도</button></div></div>';
    else toastError(errText(e));
  }).then(function () {
    // 첫 화면(장부·처음 설정·오류 안내)을 그렸다고 앱 본체에 알립니다.
    if (!firstPaint) { firstPaint = true; if (window.gz && window.gz.loaded) window.gz.loaded(); }
  });
}
/** 로그인이 풀린 채로 저장하려 하면 설정 화면으로 보냅니다. */
function failed(e) {
  if (e && e.auth) { closeSheet(); call('status').then(function (st) { showSetup(st, errText(e)); }); }
  return e;
}

// ---------- 업데이트 ----------
var UPDATE_TEXT = {
  idle: '', checking: '새 버전을 확인하는 중…', none: '최신 버전입니다.', available: '새 버전이 있습니다.',
  downloading: '새 버전을 받는 중…', ready: '새 버전이 준비됐습니다. 다시 시작하면 적용됩니다.',
  installing: '업데이트를 설치하는 중…', unsupported: '', error: ''
};
function updateText(u) {
  var t = UPDATE_TEXT[u.status] || '';
  if (u.status === 'downloading') t += ' ' + (u.progress || 0) + '%';
  if (u.status === 'error' || u.status === 'unsupported') t = u.error || '업데이트를 확인하지 못했습니다.';
  return t;
}
function setUpdate(u) {
  S.update = u || S.update;
  var bar = $('#updateBar'), u2 = S.update;
  if (u2.status === 'ready') {
    bar.hidden = false;
    bar.innerHTML = '<span><b>새 버전 ' + esc(u2.latest) + '</b> 준비됨 · 다시 시작하면 적용됩니다(앱을 끌 때도 적용).</span>' +
      '<button data-update="install">지금 다시 시작</button><button class="x" data-update="hide" aria-label="닫기">×</button>';
  } else bar.hidden = true;
  var box = $('#updateBox');
  if (box) box.innerHTML = updateBox();
}
function updateBox() {
  var u = S.update;
  return '<dl class="facts"><dt>지금 버전</dt><dd class="num">' + esc(u.current || '-') + '</dd>' +
    (u.latest && u.latest !== u.current ? '<dt>새 버전</dt><dd class="num">' + esc(u.latest) + '</dd>' : '') + '</dl>' +
    (updateText(u) ? (u.status === 'error' ? '<div class="errbox">' + esc(updateText(u)) + '</div>' : '<p class="note">' + esc(updateText(u)) + '</p>') : '') +
    (u.notes && u.latest !== u.current ? '<div class="notes">' + esc(u.notes) + '</div>' : '') +
    '<div class="btns">' + (u.status === 'ready' ? '<button class="btn pri" data-update="install">지금 다시 시작</button>'
      : '<button class="btn" data-update="check"' + (/checking|downloading|installing/.test(u.status) ? ' disabled' : '') + '>업데이트 확인</button>') + '</div>';
}
function updateAction(a, btn) {
  if (a === 'hide') { $('#updateBar').hidden = true; return; }
  if (btn) btn.disabled = true;
  if (a === 'check') call('update:check').then(setUpdate).catch(function (e) { toastError(errText(e)); setUpdate(); });
  if (a === 'install') call('update:install').then(setUpdate).catch(function (e) { toastError(errText(e)); if (btn) btn.disabled = false; });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-update]');
  if (b) updateAction(b.dataset.update, b);
});
if (window.gz && window.gz.onUpdate) window.gz.onUpdate(setUpdate);

// ---------- 처음 설정 ----------
function showSetup(st, message) {
  S.setup = true; S.status = st;
  document.body.classList.add('setup');
  closeSheet();
  var n = !st.hasClient ? 1 : !st.signedIn ? 2 : 3;
  var step = function (i, title, body, done) {
    return '<div class="card step ' + (i < n ? 'done' : i === n ? 'now' : '') + '"><span class="no">' + (i < n ? '✓' : i) + '</span><div>' +
      '<h2>' + title + '</h2>' + (i < n ? '<div class="ok">' + done + '</div>' : i === n ? body : '') + '</div></div>';
  };
  app.innerHTML = '<div class="steps"><p class="intro">처음 한 번만 하면 됩니다. 자세한 방법은 설치 안내(README)를 보세요.</p>' +
    step(1, 'OAuth 클라이언트 파일 고르기',
      '<p>Google Cloud 콘솔에서 만든 「데스크톱 앱」 클라이언트의 JSON 파일(client_secret_….json)을 고릅니다.</p>' +
      '<div class="btns"><button class="btn pri" data-setup="pickClient">파일 고르기…</button></div>', '클라이언트 파일을 골랐습니다') +
    step(2, '구글 로그인',
      '<p>브라우저가 열리면 매출 장부 시트의 주인 계정으로 로그인하고 허용을 누릅니다. 「스프레드시트 보기·수정」 항목에 꼭 체크하세요.</p>' +
      '<div class="btns"><button class="btn pri" data-setup="signIn">브라우저에서 로그인</button></div>', esc(st.email || '로그인했습니다')) +
    step(3, '매출 장부 시트 연결',
      '<p>브라우저에서 「GRAYZONE 매출 장부」를 열고 주소창의 주소를 복사해 붙여 넣습니다.</p>' +
      '<input id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off" spellcheck="false">' +
      '<div class="btns"><button class="btn pri" data-setup="setSheet">연결</button></div>', '') +
    '<div class="progress-note" id="setupNote"></div><div class="err" style="text-align:center" id="setupErr">' + esc(message || '') + '</div>' +
    (st.hasClient ? '<div class="btns" style="justify-content:center"><button class="btn" style="flex:0 0 auto" data-setup="reset">처음부터 다시</button></div>' : '') +
    '</div>';
  var u = $('#sheetUrl');
  if (u) u.focus();
}
function setupAction(action, btn) {
  var err = $('#setupErr');
  var args = [];
  if (action === 'setSheet') args = [$('#sheetUrl').value];
  if (action === 'reset' && !confirm('클라이언트 파일·로그인·시트 연결을 모두 지우고 처음부터 할까요? 시트의 내용은 바뀌지 않습니다.')) return;
  btn.disabled = true;
  var note = $('#setupNote');
  err.textContent = '';
  note.textContent = action === 'signIn' ? '브라우저에서 로그인을 마쳐 주세요…' : '';
  call(action, args).then(function (st) {
    if (st.hasClient && st.signedIn && st.spreadsheetId) return load();
    showSetup(st);
  }).catch(function (e) {
    btn.disabled = false;
    note.textContent = '';
    err.textContent = errText(e);
  });
}

// ---------- 설정 창 ----------
function showSettings() {
  if (S.setup) return;
  call('status').then(function (st) {
    var el = openSheet('<h3>설정</h3><div class="sub">연결 상태를 확인하고 바꿀 수 있습니다.</div>' +
      '<dl class="facts"><dt>구글 계정</dt><dd>' + esc(st.email || '-') + '</dd><dt>시트</dt><dd>' + esc(st.spreadsheetTitle || st.spreadsheetId) + '</dd></dl>' +
      '<label class="f">다른 시트 연결 (주소 붙여넣기)<input id="newSheet" placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off" spellcheck="false"></label>' +
      '<div class="btns"><button class="btn" data-a="sheet">시트 바꾸기</button><button class="btn" data-a="logout">로그아웃</button></div>' +
      '<h4>부가세</h4>' + (S.vat.hasSheet
        ? '<label class="f">견적금액 기준 (시트 「부가세」 탭 B5와 같음)<select id="vatBasis">' + ['부가세 별도', '부가세 포함'].map(function (o) { return '<option' + (o === S.vat.basis ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>'
        : '<p class="note">시트에 「부가세」 탭이 없어 견적금액을 부가세 별도로 보고 계산합니다.</p>') +
      '<h4>연도 묶음</h4><p class="note">마지막 연도: ' + (S.years ? S.years.last + '년' : '-') + '. 11월이 되면 다음 해 묶음을 자동으로 만들고, 다음 해 날짜로 등록할 때도 만듭니다.</p>' +
      (S.years ? '<div class="btns"><button class="btn" data-a="nextYear">' + S.years.next + '년 묶음 지금 만들기</button></div>' : '') +
      (S.hiddenChecks ? '<h4>장부 점검</h4><div class="btns"><button class="btn" data-a="resetChecks">숨긴 점검 ' + S.hiddenChecks + '건 다시 보기</button></div>' : '') +
      '<h4>업데이트</h4><div id="updateBox">' + updateBox() + '</div>' +
      '<h4>처음 상태로</h4>' +
      '<div class="btns"><button class="btn danger" data-a="reset">처음부터 다시 설정</button><button class="btn" data-a="close">닫기</button></div><div class="err"></div>');
    var basis = $('#vatBasis', el);
    if (basis) basis.addEventListener('change', function () {
      submit(el, call('setVatBasis', [basis.value]).then(function (d) { setData(d); toast('견적금액 기준을 「' + basis.value + '」로 바꿨습니다'); }));
    });
    el.addEventListener('click', function (e) {
      var a = e.target.dataset.a;
      if (a === 'close') requestClose();
      if (a === 'sheet') submit(el, call('setSheet', [$('#newSheet', el).value]).then(function () { S.loaded = false; return load(); }));
      if (a === 'logout') submit(el, call('signOut').then(function (st2) { showSetup(st2); }));
      if (a === 'nextYear' && confirm(S.years.next + '년 연도·월 묶음(200행)을 시트의 ' + S.years.last + '년 묶음 아래에 만들까요?')) submit(el, call('createNextYear').then(setData));
      if (a === 'resetChecks') submit(el, call('resetChecks').then(setData));
      if (a === 'reset' && confirm('클라이언트 파일·로그인·시트 연결을 모두 지우고 처음부터 할까요? 시트의 내용은 바뀌지 않습니다.')) {
        submit(el, call('reset').then(function (st2) { showSetup(st2); }));
      }
    });
  });
}
/** 행 하나를 고치고, 성공하면 (되돌리기 가능한) 알림을 띄웁니다. */
function patchJob(j, patch, message) {
  var undo = {};
  Object.keys(patch).forEach(function (k) { undo[k] = j[k]; });
  return call('updateJob', [j.row, expectOf(j), patch]).then(function (d) {
    setData(d);
    if (!message) return;
    toast(message, '되돌리기', function () {
      var now = S.jobs.filter(function (x) { return x.row === j.row; })[0];
      if (now) patchJob(now, undo, '되돌렸습니다').catch(function (e) { if (!failed(e).auth) toastError(errText(e)); });
    });
  });
}

// ---------- 화면 ----------
function years() {
  var set = {};
  S.jobs.forEach(function (j) { if (j.year) set[j.year] = 1; });
  set[Number(S.today.slice(0, 4))] = 1;
  return Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
}
function render() {
  var ys = years();
  if (ys.indexOf(S.year) < 0) S.year = ys[0];
  $('#year').innerHTML = ys.map(function (y) { return '<option value="' + y + '"' + (y === S.year ? ' selected' : '') + '>' + y + '년</option>'; }).join('');
  $('#sheetLink').href = S.sheetUrl;
  var open = S.jobs.filter(function (j) { return j.unpaid > 0; });
  var badge = $('#unpaidBadge');
  badge.hidden = !open.length; badge.textContent = open.length;
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
  app.innerHTML = S.tab === 'home' ? viewHome() : S.tab === 'ledger' ? viewLedger() : viewUnpaid();
  saveTab();
  if (S.tab === 'home') bindChart();
}

function monthly(year) {
  var rows = [];
  for (var m = 0; m <= 12; m++) rows.push({ m: m, count: 0, sales: 0, unpaid: 0 });
  S.jobs.forEach(function (j) {
    if (j.year !== year) return;
    var r = rows[j.month]; r.count++; r.sales += num(j.amount); r.unpaid += j.unpaid;
  });
  return rows;
}

function viewHome() {
  var y = S.year, cur = monthly(y), prev = monthly(y - 1);
  var count = sum(cur, function (r) { return r.count; }), sales = sum(cur, function (r) { return r.sales; });
  var unpaidY = sum(cur, function (r) { return r.unpaid; }), prevSales = sum(prev, function (r) { return r.sales; });
  var open = S.jobs.filter(function (j) { return j.unpaid > 0; });
  var todo = S.jobs.filter(needsInvoice);

  var html = '<div class="kpis">' +
    kpi(y + '년 매출', won(sales), count + '건 · 평균 ' + won(count ? Math.round(sales / count) : 0) + '원') +
    kpi(y + '년 미수금', won(unpaidY), sales ? '매출의 ' + (unpaidY / sales * 100).toFixed(1) + '%' : '') +
    kpi('전체 미수금', won(sum(open, function (j) { return j.unpaid; })), open.length + '건 보기 ›', 'unpaid:all') +
    kpi('계산서 미발행', todo.length, won(sum(todo, function (j) { return j.unpaid; })) + '원 보기 ›', 'unpaid:noinv', '건') +
    '</div>';
  if (S.checks.length) {
    html += '<button class="banner" data-go="ledger:check"><b>장부 점검</b><span>확인할 항목 ' + S.checks.length + '건</span><span class="go">보기 ›</span></button>';
  }

  html += '<div class="card"><h2>월별 매출</h2>' +
    '<div class="legend"><span><i style="background:var(--s1)"></i>' + y + '년</span><span><i style="background:var(--s2)"></i>' + (y - 1) + '년</span></div>' +
    '<div class="readout num" id="readout"></div>' + chart(cur, prev) + '</div>';

  html += flowCard(y);

  html += '<div class="card"><h2>월별 표</h2><table class="num"><thead><tr><th>월</th><th>건수</th><th>' + y + '년 매출</th><th>미수금</th><th>전년 대비</th></tr></thead><tbody>';
  cur.forEach(function (r) {
    if (r.m === 0 && !r.count) return;
    var p = prev[r.m].sales;
    html += '<tr><td>' + (r.m ? r.m + '월' : '기타') + '</td><td>' + (r.count || '<span class="dim">-</span>') + '</td><td>' + (r.count ? won(r.sales) : '-') + '</td>' +
      '<td>' + (r.unpaid ? won(r.unpaid) : '-') + '</td><td class="dim">' + yoy(r.sales, p, r.count) + '</td></tr>';
  });
  html += '</tbody><tfoot><tr><td>합계</td><td>' + count + '</td><td>' + won(sales) + '</td><td>' + (unpaidY ? won(unpaidY) : '-') + '</td><td>' + yoy(sales, prevSales, count) + '</td></tr></tfoot></table></div>';

  html += vatCard(y);

  var by = {};
  S.jobs.forEach(function (j) {
    if (j.year !== y || !j.client) return;
    var c = by[j.client] || (by[j.client] = { name: j.client, count: 0, sales: 0 });
    c.count++; c.sales += num(j.amount);
  });
  var top = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.sales - a.sales; }).slice(0, 8);
  if (top.length) {
    html += '<div class="card"><h2>' + y + '년 거래처 매출 상위</h2>' + top.map(function (c) {
      return '<div class="rank"><span>' + esc(c.name) + '<small>' + c.count + '건</small></span><span class="num">' + won(c.sales) + '</span>' +
        '<div class="meter"><i style="width:' + (top[0].sales ? c.sales / top[0].sales * 100 : 0) + '%"></i></div></div>';
    }).join('') + '</div>';
  }
  return html;
}
/**
 * 연간 흐름판: 가로 1~12월, 세로 1~5주(1~7일, 8~14일, …, 29일~). 칸이 밝을수록 그 주의 매출이 큽니다.
 * 미수가 남은 주는 ⚠. 칸을 누르면 그 주의 작업이 아래에 열립니다.
 */
var FLOW_GRAYS = ['#3A3A3A', '#5E5E5E', '#8A8A8A', '#ABABAB', '#E0E0E0'];
function flowCard(y) {
  var cells = {}, max = 0;
  S.jobs.forEach(function (j) {
    if (j.year !== y || !isIso(j.date)) return;
    var k = Number(j.date.slice(5, 7)) + '-' + Math.min(5, Math.ceil(Number(j.date.slice(8)) / 7));
    var c = cells[k] || (cells[k] = { jobs: [], sales: 0, unpaid: 0 });
    c.jobs.push(j); c.sales += num(j.amount); c.unpaid += j.unpaid;
    if (c.sales > max) max = c.sales;
  });
  var html = '<div class="card"><h2>연간 흐름</h2>' +
    '<div class="legend"><span>적음 ' + FLOW_GRAYS.map(function (g) { return '<i style="background:' + g + ';margin-right:2px"></i>'; }).join('') + ' 많음</span><span><span class="warn-mark"></span> 미수 있음</span></div>' +
    '<div class="note" style="margin:0 0 8px">칸은 한 주(1~7일, 8~14일 …)입니다. 누르면 그 주의 작업이 보입니다.</div>' +
    '<div class="flow" role="grid" aria-label="' + y + '년 주별 매출"><span></span>';
  for (var m = 1; m <= 12; m++) html += '<span class="fh num">' + m + '</span>';
  for (var w = 1; w <= 5; w++) {
    html += '<span class="fw">' + w + '주</span>';
    for (m = 1; m <= 12; m++) {
      var k = m + '-' + w, c = cells[k], key = y + '-' + k;
      if (!c) { html += '<span class="fc empty"></span>'; continue; }
      var lv = c.sales > 0 && max ? Math.min(4, Math.floor(Math.sqrt(c.sales / max) * 5)) : -1;
      html += '<button class="fc' + (S.flow === key ? ' on' : '') + '" data-flow="' + key + '" style="' + (lv >= 0 ? 'background:' + FLOW_GRAYS[lv] : '') + '"' +
        ' aria-label="' + m + '월 ' + w + '주 ' + c.jobs.length + '건 ' + won(c.sales) + '원' + (c.unpaid ? ' 미수 ' + won(c.unpaid) + '원' : '') + '">' +
        (c.unpaid ? '<span class="warn-mark' + (lv >= 2 ? ' dark' : '') + '"></span>' : '') + '</button>';
    }
  }
  html += '</div>';
  var sel = S.flow && S.flow.indexOf(y + '-') === 0 ? cells[S.flow.slice(String(y).length + 1)] : null;
  if (sel) {
    var p = S.flow.split('-');
    html += '<div class="group"><b>' + p[1] + '월 ' + p[2] + '주</b><span class="num">' + sel.jobs.length + '건 · ' + won(sel.sales) + '원' + (sel.unpaid ? ' · 미수 ' + won(sel.unpaid) + '원' : '') + '</span></div>' +
      '<div class="list">' + sel.jobs.sort(function (a, b) { return (a.date > b.date) - (a.date < b.date) || a.row - b.row; }).map(function (j) { return item(j); }).join('') + '</div>';
  }
  return html + '</div>';
}
/** 분기별 부가세 (납품일 기준). 시트 「부가세」 탭과 같은 표입니다. */
function vatCard(y) {
  var q = [1, 2, 3, 4].map(function (n) { return { n: n, count: 0, supply: 0, vat: 0, total: 0, noInv: 0, noInvSupply: 0 }; });
  S.jobs.forEach(function (j) {
    if (!isIso(j.date) || Number(j.date.slice(0, 4)) !== y) return;
    var r = q[Math.floor((Number(j.date.slice(5, 7)) - 1) / 3)], v = vatOf(j.amount);
    r.count++; r.supply += v.supply; r.vat += v.vat; r.total += v.total;
    if (j.invoice !== '완료') { if (num(j.amount) > 0) r.noInv++; r.noInvSupply += v.supply; }
  });
  var row = function (label, sub, rs, cls) {
    var t = { supply: sum(rs, function (r) { return r.supply; }), vat: sum(rs, function (r) { return r.vat; }), total: sum(rs, function (r) { return r.total; }),
      noInv: sum(rs, function (r) { return r.noInv; }), noInvSupply: sum(rs, function (r) { return r.noInvSupply; }) };
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + label + '<div class="cap">' + sub + '</div></td><td>' + won(t.supply) + '</td><td>' + won(t.vat) + '</td><td>' + won(t.total) + '</td>' +
      '<td class="' + (t.noInv ? 'warn' : 'dim') + '">' + (t.noInv ? t.noInv + '건<div class="cap">' + won(t.noInvSupply) + '</div>' : '-') + '</td></tr>';
  };
  return '<div class="card"><h2>' + y + '년 부가세 <span class="h2note">납품일 기준 · 견적금액 ' + esc(S.vat.basis) + '</span></h2>' +
    '<div class="scroll-x"><table class="num vat"><thead><tr><th>분기</th><th>공급가</th><th>부가세</th><th>합계</th><th>계산서 미발행</th></tr></thead><tbody>' +
    row('1분기', '1기 예정 · 1~3월', [q[0]]) + row('2분기', '1기 확정 · 4~6월', [q[1]]) + row('1기 합계', '1~6월', [q[0], q[1]], 'sub') +
    row('3분기', '2기 예정 · 7~9월', [q[2]]) + row('4분기', '2기 확정 · 10~12월', [q[3]]) + row('2기 합계', '7~12월', [q[2], q[3]], 'sub') +
    '</tbody><tfoot>' + row('연간', '1~12월', q) + '</tfoot></table></div>' +
    '<p class="note">실제 신고는 세금계산서 작성일 기준입니다. 납품일과 계산서 날짜가 다른 건은 신고 때 확인하세요.</p></div>';
}
function kpi(label, value, sub, go, unit) {
  var inner = '<div class="label">' + label + '</div><div class="value num">' + value + '<small>' + (unit || '원') + '</small></div><div class="sub num">' + (sub || '&nbsp;') + '</div>';
  return go ? '<button class="kpi" data-go="' + go + '">' + inner + '</button>' : '<div class="kpi">' + inner + '</div>';
}
function yoy(now, before, count) {
  if (!before || !count) return '-';
  var p = (now - before) / before * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
}

// 월별 매출 막대 차트: 올해(파랑)와 전년(주황), 축은 하나.
function chart(cur, prev) {
  var W = Math.max(280, Math.min(730, app.clientWidth - 30)), H = 210, L = 56, R = 4, T = 10, B = 24;
  var max = 0;
  for (var m = 1; m <= 12; m++) max = Math.max(max, cur[m].sales, prev[m].sales);
  var step = niceStep(max || 1), top = Math.max(step, Math.ceil(max / step) * step);
  var pw = (W - L - R) / 12, ph = H - T - B, bw = Math.max(3, Math.min(16, (pw - 8) / 2));
  var yOf = function (v) { return T + ph - v / top * ph; };
  var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="월별 매출 막대 차트. 같은 값은 아래 월별 표에 있습니다.">';
  for (var v = 0; v <= top + 1; v += step) {
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yOf(v) + '" y2="' + yOf(v) + '" stroke="var(--' + (v ? 'line' : 'axis') + ')"/>' +
      '<text x="' + (L - 6) + '" y="' + (yOf(v) + 4) + '" text-anchor="end">' + (v ? man(v) : '0') + '</text>';
  }
  for (m = 1; m <= 12; m++) {
    var x = L + (m - 1) * pw, cx = x + pw / 2;
    s += '<rect class="hit" data-m="' + m + '" x="' + x + '" y="' + T + '" width="' + pw + '" height="' + ph + '"/>' +
      bar(cx - bw - 1, yOf(cur[m].sales), bw, T + ph, 'var(--s1)') + bar(cx + 1, yOf(prev[m].sales), bw, T + ph, 'var(--s2)') +
      '<text x="' + cx + '" y="' + (H - 7) + '" text-anchor="middle">' + m + (pw >= 34 ? '월' : '') + '</text>';
  }
  return s + '</svg>';
}
function bar(x, y, w, base, color) {
  var h = base - y;
  if (h <= 0) return '';
  var r = Math.min(4, h, w / 2);
  return '<path pointer-events="none" fill="' + color + '" d="M' + x + ',' + base + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
    'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + base + 'Z"/>';
}
function niceStep(max) {
  var raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function bindChart() {
  var svg = $('svg.chart'), out = $('#readout');
  if (!svg) return;
  var cur = monthly(S.year), prev = monthly(S.year - 1);
  function show(m) {
    Array.prototype.forEach.call(svg.querySelectorAll('.hit'), function (h) { h.classList.toggle('on', Number(h.dataset.m) === m); });
    if (!m) { out.innerHTML = '<span style="color:var(--muted)">막대를 누르면 그 달의 금액이 보입니다.</span>'; return; }
    out.innerHTML = '<b>' + m + '월</b> · ' + S.year + '년 ' + won(cur[m].sales) + '원 (' + cur[m].count + '건) · ' + (S.year - 1) + '년 ' + won(prev[m].sales) + '원' +
      (prev[m].sales && cur[m].count ? ' · ' + yoy(cur[m].sales, prev[m].sales, 1) : '');
  }
  function pick(e) { var m = e.target && e.target.dataset && Number(e.target.dataset.m); if (m) show(m); }
  svg.addEventListener('pointermove', pick);
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') show(0); });
  show(0);
}

function tags(j) {
  var t = '';
  if (j.type) t += '<span class="tag">' + esc(j.type) + '</span>';
  if (j.unpaid > 0) {
    t += j.invoice === '완료' ? '<span class="tag wait">계산서 발행 · 입금 대기</span>' : '<span class="tag bad">계산서 미발행</span>';
    if (num(j.paidAmount) > 0) t += '<span class="tag wait">일부 입금</span>';
  } else if (j.paid === '완료') {
    t += '<span class="tag ok">입금 완료</span>';
  }
  return t;
}
function item(j, opt) {
  opt = opt || {};
  var day = isIso(j.date) ? (opt.fullDate ? j.date.slice(2).replace(/-/g, '.') : j.date.slice(5).replace('-', '.')) : esc(j.date || '-');
  var h = '<button class="item" data-row="' + j.row + '"><span class="day num">' + day + '</span>' +
    '<span class="main"><div class="t">' + esc(j.title || '(내용 없음)') + '</div><div class="s">' + esc(j.client) + (people(j) ? ' · ' + esc(people(j)) : '') + '</div></span>' +
    '<span><div class="amt num">' + (j.amount === '' ? '-' : won(j.amount)) + '</div><div class="tags">' + tags(j) + '</div></span>';
  return h + '</button>';
}
function ageTag(j) {
  var d = daysSince(j.date);
  var t = d === null ? '' : '<span class="tag' + (d > 90 ? ' bad' : '') + '">' + (d >= 0 ? d + '일 경과' : '납품 전') + '</span>';
  return t + (num(j.paidAmount) > 0 ? '<span class="tag wait">일부 입금</span>' : '');
}
function chip(group, key, label, cur) { return '<button class="chip' + (cur === key ? ' on' : '') + '" data-' + group + '="' + key + '">' + label + '</button>'; }

// 마지막에 보던 탭을 기억합니다.
function loadTab() { try { var t = localStorage.getItem('gz.tab'); return /^(home|ledger|unpaid)$/.test(t) ? t : 'home'; } catch (e) { return 'home'; } }
function saveTab() { try { localStorage.setItem('gz.tab', S.tab); } catch (e) { /* 기억 못 해도 동작 */ } }

// ---------- 장부: 달마다 접고 펴기 ----------
// 펼친 달은 이 컴퓨터에 기억합니다({ '2026-11': true, '2026-10': false }). 처음 보는 해는 가장 최근 달만 펼칩니다.
function loadOpen() { try { return JSON.parse(localStorage.getItem('gz.open') || '{}') || {}; } catch (e) { return {}; } }
function saveOpen() { try { localStorage.setItem('gz.open', JSON.stringify(S.open)); } catch (e) { /* 기억 못 해도 동작 */ } }
function monthKey(m) { return S.year + '-' + m; }
function isOpen(m, first) { var k = monthKey(m); return k in S.open ? S.open[k] : first; }

function viewLedger() {
  return '<div class="tools"><input type="search" id="q" placeholder="거래처·내용·감독·PD 검색 (전체 연도) · ⌘F" value="' + esc(S.q) + '"></div>' +
    '<div class="chips">' + chip('lf', 'all', '전체', S.lf) + chip('lf', 'unpaid', '미수', S.lf) + chip('lf', 'noinv', '계산서 미발행', S.lf) +
    chip('lf', 'check', '점검' + (S.checks.length ? ' ' + S.checks.length : ''), S.lf) +
    (S.lf === 'all' && !S.q.trim() ? '<span class="gap"></span><button class="chip" data-months="open">모두 펼치기</button><button class="chip" data-months="close">모두 접기</button>' : '') + '</div>' +
    '<div id="ledgerList">' + ledgerList() + '</div>';
}
function ledgerList() {
  if (S.lf === 'check') return checkList();
  var q = S.q.trim().toLowerCase();
  var list = S.jobs.filter(function (j) {
    if (q) { if ([j.client, j.title, j.director, j.pd, j.note].join(' ').toLowerCase().indexOf(q) < 0) return false; }
    else if (j.year !== S.year) return false;
    if (S.lf === 'unpaid') return j.unpaid > 0;
    if (S.lf === 'noinv') return needsInvoice(j);
    return true;
  });
  var html = '';
  if (!list.length) return '<div class="empty">' + (q ? '검색 결과가 없습니다.' : '해당하는 작업이 없습니다.') + '</div>';

  var groups = {}, order = [];
  list.slice().sort(function (a, b) { return (b.date > a.date) - (b.date < a.date) || b.row - a.row; }).forEach(function (j) {
    var key = q ? String(j.year) : String(j.month);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(j);
  });
  if (!q) order.sort(function (a, b) { return (Number(b) || -1) - (Number(a) || -1); }); // 최근 달이 위, 기타는 맨 아래
  // 전체 보기(검색·필터 없음)에서만 달마다 접고 폅니다. 검색·미수·미발행은 찾은 것을 모두 펼쳐 보여 줍니다.
  var foldable = !q && S.lf === 'all';
  order.forEach(function (key, i) {
    var g = groups[key], u = sum(g, function (j) { return j.unpaid; });
    var name = q ? (key === 'null' ? '연도 없음' : key + '년') : (key === '0' ? '기타' : key + '월');
    var info = g.length + '건 · ' + won(sum(g, function (j) { return num(j.amount); })) + '원' + (u ? ' · <span class="due">미수 ' + won(u) + '원</span>' : '');
    if (!foldable) {
      html += '<div class="group"><b>' + name + '</b><span class="num">' + info + '</span></div>' +
        '<div class="list">' + g.map(function (j) { return item(j, { fullDate: !!q }); }).join('') + '</div>';
      return;
    }
    var open = isOpen(key, i === 0);
    html += '<section class="month' + (open ? ' open' : '') + '">' +
      '<button class="month-head" data-month="' + key + '" aria-expanded="' + open + '"><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><b>' + name + '</b><span class="num">' + info + '</span></button>' +
      (open ? '<div class="list">' + g.map(function (j) { return item(j); }).join('') + '</div>' : '') + '</section>';
  });
  return html;
}

/** 장부 점검: 고칠 만한 행을 이유별로 모아 보여 줍니다(모든 연도). */
function checkList() {
  var q = S.q.trim().toLowerCase();
  var list = S.checks.filter(function (c) {
    var j = jobAt(c.row);
    return j && (!q || [j.client, j.title, j.director, j.pd, j.note].join(' ').toLowerCase().indexOf(q) >= 0);
  });
  var foot = S.hiddenChecks ? '<p class="note center">「문제없음」으로 숨긴 항목 ' + S.hiddenChecks + '건 · 설정에서 다시 볼 수 있습니다.</p>' : '';
  if (!list.length) return '<div class="empty">' + (q ? '검색 결과가 없습니다.' : '확인할 항목이 없습니다. 장부가 깔끔합니다.') + '</div>' + foot;
  var groups = {}, order = [];
  list.forEach(function (c) { if (!groups[c.type]) { groups[c.type] = []; order.push(c.type); } groups[c.type].push(c); });
  var html = '<p class="note">시트는 바꾸지 않습니다. 항목을 눌러 고치거나, 맞는 내용이면 「문제없음」을 누르세요.</p>';
  order.forEach(function (t) {
    var g = groups[t];
    html += '<div class="group"><b>' + esc(g[0].label) + '</b><span class="num">' + g.length + '건</span></div>' +
      '<div class="list">' + g.map(function (c) { return item(jobAt(c.row), { fullDate: true }); }).join('') + '</div>';
  });
  return html + foot;
}

function viewUnpaid() {
  var all = S.jobs.filter(function (j) { return j.unpaid > 0; });
  var list = all.filter(function (j) { return S.uf === 'all' || (S.uf === 'noinv') === (j.invoice !== '완료'); });
  var total = sum(list, function (j) { return j.unpaid; });
  var withVat = sum(list, function (j) { return vatOf(j.unpaid).total; });
  var html = '<div class="kpis">' + kpi('미수금', won(total), list.length + '건' + (S.vat.basis === '부가세 포함' ? ' · 부가세 포함' : ' · 부가세 포함 ' + won(withVat) + '원')) +
    kpi('90일 넘은 미수', won(sum(list, function (j) { return daysSince(j.date) > 90 ? j.unpaid : 0; })), list.filter(function (j) { return daysSince(j.date) > 90; }).length + '건') + '</div>' +
    '<div class="chips">' + chip('uf', 'all', '전체', S.uf) + chip('uf', 'noinv', '계산서 미발행', S.uf) + chip('uf', 'wait', '입금 대기', S.uf) +
    '<span class="gap"></span>' + chip('us', 'new', '최신순', S.us) + chip('us', 'old', '월별', S.us) + chip('us', 'big', '금액순', S.us) + chip('us', 'client', '거래처별', S.us) + '</div>' +
    (S.us === 'old' && list.length ? '<div class="chips"><span class="gap"></span><button class="chip" data-umonths="open">모두 펼치기</button><button class="chip" data-umonths="close">모두 접기</button></div>' : '');
  if (!list.length) return html + '<div class="empty">미수금이 없습니다.</div>';

  var byDate = function (a, b) { return (a.date > b.date) - (a.date < b.date) || a.row - b.row; };
  if (S.us === 'client') {
    var by = {};
    list.forEach(function (j) { (by[j.client] || (by[j.client] = [])).push(j); });
    Object.keys(by).map(function (k) { return { name: k, jobs: by[k].sort(byDate), total: sum(by[k], function (j) { return j.unpaid; }) }; })
      .sort(function (a, b) { return b.total - a.total; })
      .forEach(function (c) {
        html += '<div class="group"><b>' + esc(c.name || '(거래처 없음)') + '</b><span class="num">' + c.jobs.length + '건 · ' + won(c.total) + '원</span></div>' +
          '<div class="list">' + c.jobs.map(unpaidItem).join('') + '</div>';
      });
    return html;
  }
  if (S.us === 'new') {
    list.sort(function (a, b) { return -byDate(a, b); });
    return html + '<div class="list">' + list.map(unpaidItem).join('') + '</div>';
  }
  if (S.us === 'big') {
    list.sort(function (a, b) { return b.unpaid - a.unpaid || byDate(a, b); });
    return html + '<div class="list">' + list.map(unpaidItem).join('') + '</div>';
  }
  // 월별(오래된 달이 위): 달마다 접고 폅니다. 처음에는 가장 오래된 달만 펼쳐 둡니다. 펼친 달은 기억합니다.
  var months = {}, order = [];
  list.sort(byDate).forEach(function (j) {
    var k = isIso(j.date) ? j.date.slice(0, 7) : '';
    if (!months[k]) { months[k] = []; order.push(k); }
    months[k].push(j);
  });
  order.forEach(function (k, i) {
    var g = months[k], key = 'u:' + k, open = key in S.open ? S.open[key] : i === 0;
    var name = k ? Number(k.slice(0, 4)) + '년 ' + Number(k.slice(5)) + '월' : '날짜 없음';
    var late = g.filter(function (j) { return daysSince(j.date) > 90; }).length;
    html += '<section class="month' + (open ? ' open' : '') + '">' +
      '<button class="month-head" data-umonth="' + key + '" aria-expanded="' + open + '"><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><b>' + name + '</b>' +
      '<span class="num">' + g.length + '건 · <span class="due">' + won(sum(g, function (j) { return j.unpaid; })) + '원</span>' + (late ? ' · 90일 넘음 ' + late + '건' : '') + '</span></button>' +
      (open ? '<div class="list">' + g.map(unpaidItem).join('') + '</div>' : '') + '</section>';
  });
  return html;
}
function unpaidItem(j) {
  var day = isIso(j.date) ? j.date.slice(2).replace(/-/g, '.') : esc(j.date || '-');
  return '<div class="item" data-row="' + j.row + '"><span class="day num">' + day + '</span>' +
    '<span class="main"><div class="t">' + esc(j.title || '(내용 없음)') + '</div><div class="s">' + esc(j.client) + (people(j) ? ' · ' + esc(people(j)) : '') + '</div></span>' +
    '<span><div class="amt num">' + won(j.unpaid) + '</div><div class="tags">' + ageTag(j) + '</div></span>' +
    '<span class="acts">' + (j.invoice !== '완료' ? '<button data-act="invoice" data-row="' + j.row + '">계산서 발행</button>' : '<span class="tag ok" style="align-self:center;margin:0 4px 0 0">계산서 발행됨</span>') +
    '<button class="pri" data-act="pay" data-row="' + j.row + '">입금 처리</button><button data-act="detail" data-row="' + j.row + '">자세히</button></span></div>';
}

// ---------- 알림·창 ----------
var toastTimer = null;
function toastError(msg) { toast(msg, null, null, true); }
function toast(msg, action, fn, isError) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = '<div class="toast' + (isError ? ' error' : '') + '" role="status"><span>' + esc(msg) + '</span>' + (action ? '<button>' + action + '</button>' : '') + '</div>';
  if (action) $('button', toastEl).onclick = function () { toastEl.innerHTML = ''; fn(); };
  toastTimer = setTimeout(function () { toastEl.innerHTML = ''; }, action ? 7000 : 4000);
}
function openSheet(html) {
  modal.innerHTML = '<div class="scrim"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
  var sheet = $('.sheet', modal);
  sheetDirty = false;
  // 오류 줄과 버튼 줄을 한 묶음으로 아래에 고정합니다(오류가 입력 칸을 덮지 않게).
  var err = $(':scope > .err', sheet), btns = err && err.previousElementSibling;
  if (err && btns && btns.classList.contains('btns')) {
    var foot = document.createElement('div');
    foot.className = 'foot';
    sheet.insertBefore(foot, btns);
    foot.appendChild(err); foot.appendChild(btns);
  }
  // 입력이 바뀌면: 남아 있던 오류를 지우고, 닫을 때 확인하도록 표시합니다.
  var touched = function (e) { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { sheetDirty = true; if (err) err.textContent = ''; } };
  sheet.addEventListener('input', touched);
  sheet.addEventListener('change', touched);
  // 바깥을 눌러 닫기: 입력한 것이 없을 때만
  $('.scrim', modal).addEventListener('mousedown', function (e) { if (e.target === e.currentTarget && !sheetDirty) closeSheet(); });
  return sheet;
}
var sheetDirty = false;
function closeSheet() { modal.innerHTML = ''; sheetDirty = false; }
/** 취소·Esc: 입력한 내용이 있으면 한 번 확인합니다. */
function requestClose() {
  if (!modal.innerHTML) return true;
  if (sheetDirty && !confirm('입력한 내용을 버릴까요?')) return false;
  closeSheet();
  return true;
}
function jobAt(row) { return S.jobs.filter(function (j) { return j.row === Number(row); })[0]; }
function submit(el, promise) {
  var btns = el.querySelectorAll('button'), err = $('.err', el);
  var main = $('[data-a=save], [data-a=ok]', el), label = main && main.textContent;
  Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
  if (main) main.textContent = '저장하는 중…';
  if (err) err.textContent = '';
  return promise.then(function (r) { closeSheet(); return r; }, function (e) {
    if (e && e.auth) { failed(e); return; }
    Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
    if (main) main.textContent = label;
    if (err) err.textContent = errText(e); else toastError(errText(e));
    throw e;
  }).catch(function () {});
}

function showDetail(j) {
  var fact = function (k, v) { return v === '' || v == null ? '' : '<dt>' + k + '</dt><dd>' + v + '</dd>'; };
  var issues = checksOf(j);
  var el = openSheet('<h3>' + esc(j.title || '(내용 없음)') + '</h3><div class="sub">' + esc(j.client) + '</div><div>' + tags(j) + '</div>' +
    (issues.length ? '<div class="issues">' + issues.map(function (c) {
      return '<div class="issue"><span>' + esc(c.label) + '</span><button data-a="dismiss" data-key="' + esc(c.key) + '">문제없음</button></div>';
    }).join('') + '</div>' : '') +
    '<dl class="facts num">' + fact('납품일', esc(j.date)) + fact('감독', esc(j.director)) + fact('PD', esc(j.pd)) +
    fact('견적금액', j.amount === '' ? '' : won(j.amount) + '원') +
    (typeof j.amount === 'number' && j.amount > 0 ? (function (v) { return fact('공급가', won(v.supply) + '원') + fact('부가세', won(v.vat) + '원') + fact('합계', won(v.total) + '원'); })(vatOf(j.amount)) : '') +
    fact('미수금', j.unpaid ? won(j.unpaid) + '원' : '') +
    fact('견적서', esc(j.quote)) + fact('계산서', esc(j.invoice)) + fact('지급', esc(j.paid)) +
    fact('입금액', j.paidAmount === '' ? '' : won(j.paidAmount) + '원') + fact('입금일', esc(j.paidDate)) +
    fact('인센티브', j.incentive === '' ? '' : (typeof j.incentive === 'number' ? won(j.incentive) + '원' : esc(j.incentive))) +
    fact('비고', esc(j.note)) + fact('추가정보', esc(j.extra)) + fact('귀속연도', esc(j.attrYear)) + fact('시트 행', j.row + '행') + '</dl>' +
    '<div class="btns">' +
    (j.invoice !== '완료' ? '<button class="btn" data-a="invoice">계산서 발행</button>' : '') +
    (j.unpaid > 0 ? '<button class="btn pri" data-a="pay">입금 처리</button>' : '') +
    '<button class="btn" data-a="edit">수정</button><button class="btn" data-a="close">닫기</button></div><div class="err"></div>');
  el.addEventListener('click', function (e) {
    var a = e.target.dataset.a;
    if (a === 'close') requestClose();
    if (a === 'edit') showForm(j);
    if (a === 'pay') showPay(j);
    if (a === 'invoice') submit(el, patchJob(j, { invoice: '완료' }, '계산서 발행으로 표시했습니다'));
    if (a === 'dismiss') {
      var key = e.target.dataset.key;
      call('dismissCheck', [key]).then(function (d) {
        setData(d);
        var row = e.target.closest('.issue');
        if (row) row.remove();
        toast('점검 목록에서 숨겼습니다');
      }).catch(function (err) { if (!failed(err).auth) toastError(errText(err)); });
    }
  });
}

function showPay(j) {
  var mode = 'full';
  var el = openSheet('<h3>입금 처리</h3><div class="sub">' + esc(j.client) + ' · ' + esc(j.title) + ' · 미수 ' + won(j.unpaid) + '원</div>' +
    '<div class="seg"><button data-mode="full" class="on">전액 입금</button><button data-mode="part">일부 입금</button></div>' +
    '<label class="f">입금일<input type="date" id="pDate" value="' + S.today + '"></label>' +
    '<label class="f" id="pAmtWrap" hidden>지금까지 받은 금액 (견적금액 ' + won(j.amount) + '원)<input id="pAmt" class="money" inputmode="numeric" value="' + (num(j.paidAmount) ? won(j.paidAmount) : '') + '"></label>' +
    '<div class="btns"><button class="btn" data-a="close">취소</button><button class="btn pri" data-a="ok">저장</button></div><div class="err"></div>');
  el.addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset.mode) {
      mode = t.dataset.mode;
      Array.prototype.forEach.call(el.querySelectorAll('.seg button'), function (b) { b.classList.toggle('on', b === t); });
      $('#pAmtWrap', el).hidden = mode !== 'part';
      $('.err', el).textContent = '';
      if (mode === 'part') $('#pAmt', el).focus();
    }
    if (t.dataset.a === 'close') requestClose();
    if (t.dataset.a === 'ok') {
      var date = $('#pDate', el).value, patch;
      if (mode === 'full') patch = { paid: '완료', paidDate: date };
      else {
        var got = digits($('#pAmt', el).value);
        if (got === '' || got <= 0) { $('.err', el).textContent = '받은 금액을 입력해 주세요.'; return; }
        if (got >= num(j.amount)) { $('.err', el).textContent = '견적금액 이상이면 「전액 입금」을 선택해 주세요.'; return; }
        patch = { paidAmount: got, paidDate: date };
      }
      submit(el, patchJob(j, patch, mode === 'full' ? '입금 완료로 표시했습니다' : '일부 입금을 기록했습니다'));
    }
  });
}

function showForm(j) {
  var edit = !!j;
  j = j || { date: S.today, client: '', director: '', pd: '', title: '', amount: '', type: '', quote: '', invoice: '', paid: '', paidAmount: '', paidDate: '', incentive: '', note: '', attrYear: '' };
  var uniq = function (f) { var s = {}; S.jobs.forEach(function (x) { if (x[f]) s[x[f]] = 1; }); return Object.keys(s).sort(function (a, b) { return a.localeCompare(b, 'ko'); }); };
  var dl = function (id, f) { return '<datalist id="' + id + '">' + uniq(f).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>'; };
  var sel = function (id, label, opts, v) {
    if (opts.indexOf(v) < 0) opts = opts.concat([v]);
    return '<label class="f">' + label + '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + (o === '' ? '(비움)' : esc(o)) + '</option>'; }).join('') + '</select></label>';
  };
  var money = function (id, label, v, hint) { return '<label class="f">' + label + '<input id="' + id + '" class="money" inputmode="numeric" value="' + (v === '' ? '' : typeof v === 'number' ? won(v) : esc(v)) + '">' + (hint ? '<span class="hint num" id="' + hint + '"></span>' : '') + '</label>'; };
  var el = openSheet('<h3>' + (edit ? '작업 수정' : '작업 등록') + '</h3><div class="sub">' + (edit ? '시트 ' + j.row + '행' : '납품일이 속한 달 묶음에 자동으로 들어갑니다.') + '</div>' +
    '<div class="row"><label class="f">납품일<input type="date" id="fDate" value="' + (isIso(j.date) ? j.date : '') + '"></label>' + money('fAmount', '견적금액 (원, ' + esc(S.vat.basis) + ')', j.amount, 'vatHint') + '</div>' +
    '<label class="f">거래처<input id="fClient" list="dlClient" autocomplete="off" value="' + esc(j.client) + '"></label>' + dl('dlClient', 'client') +
    '<label class="f">내용<input id="fTitle" autocomplete="off" value="' + esc(j.title) + '"></label>' +
    '<div class="row"><label class="f">감독<input id="fDirector" list="dlDirector" autocomplete="off" value="' + esc(j.director) + '"></label>' +
    '<label class="f">PD<input id="fPd" list="dlPd" autocomplete="off" value="' + esc(j.pd) + '"></label></div>' + dl('dlDirector', 'director') + dl('dlPd', 'pd') +
    '<label class="check"><input type="checkbox" id="fService"' + (j.type === '서비스' ? ' checked' : '') + '> 서비스 건 (견적금액 0)</label>' +
    '<details' + (edit ? ' open' : '') + '><summary>계산서·입금·비고</summary>' +
    '<div class="row">' + sel('fInvoice', '계산서', ['', '완료', 'X', '*'], j.invoice) + sel('fPaid', '지급', ['', '완료', 'X'], j.paid) + '</div>' +
    '<div class="row">' + money('fPaidAmount', '입금액 (일부 입금)', j.paidAmount) + '<label class="f">입금일<input type="date" id="fPaidDate" value="' + (isIso(j.paidDate) ? j.paidDate : '') + '"></label></div>' +
    '<div class="row">' + sel('fQuote', '견적서', ['', '완료', 'X'], j.quote) + money('fIncentive', '인센티브', j.incentive) + '</div>' +
    '<label class="f">비고<textarea id="fNote">' + esc(j.note) + '</textarea></label>' +
    '<label class="f">귀속연도 (다른 해 매출로 잡을 때만)<input id="fAttrYear" inputmode="numeric" maxlength="4" value="' + esc(j.attrYear) + '"></label></details>' +
    '<div class="btns">' + (edit ? '<button class="btn danger" data-a="del">삭제</button>' : '') + '<button class="btn" data-a="close">취소</button><button class="btn pri" data-a="save">' + (edit ? '저장' : '등록') + '</button></div><div class="err"></div>');

  var v = function (id) { return $('#' + id, el).value.trim(); };
  var showVat = function () {
    var a = digits(v('fAmount')), h = $('#vatHint', el);
    if (a === '' || a === 0) { h.textContent = ''; return; }
    var x = vatOf(a);
    h.textContent = '공급가 ' + won(x.supply) + ' · 부가세 ' + won(x.vat) + ' · 합계 ' + won(x.total);
  };
  $('#fAmount', el).addEventListener('input', showVat);
  showVat();
  $('#fService', el).addEventListener('change', function (e) { if (e.target.checked) $('#fAmount', el).value = '0'; showVat(); });
  $('#fClient', el).addEventListener('change', function () { // 같은 거래처의 최근 감독·PD 를 채워 줍니다.
    if (edit || v('fDirector') || v('fPd')) return;
    var last = S.jobs.filter(function (x) { return x.client === v('fClient'); }).sort(function (a, b) { return (b.date > a.date) - (b.date < a.date); })[0];
    if (last) { $('#fDirector', el).value = last.director; $('#fPd', el).value = last.pd; }
  });
  var armed = false;
  el.addEventListener('click', function (e) {
    var a = e.target.dataset.a;
    if (a === 'close') requestClose();
    if (a === 'del') {
      if (!armed) {
        // 첫 클릭: 무엇을 지우는지 보여 주고, 더블클릭으로 바로 지워지지 않게 잠깐 막습니다. 5초 안에 다시 누르지 않으면 원래대로.
        armed = true;
        var delBtn = e.target, note = document.createElement('div');
        note.className = 'confirm-note';
        note.textContent = '「' + (j.title || '(내용 없음)') + '」(' + (j.amount === '' ? '금액 없음' : won(j.amount) + '원') + ')을 시트에서 지웁니다. 되돌릴 수 없습니다.';
        delBtn.closest('.btns').parentNode.insertBefore(note, delBtn.closest('.btns'));
        delBtn.textContent = '정말 삭제'; delBtn.disabled = true;
        setTimeout(function () { delBtn.disabled = false; }, 600);
        setTimeout(function () { if (document.body.contains(note)) { note.remove(); delBtn.textContent = '삭제'; armed = false; } }, 5000);
        return;
      }
      submit(el, call('deleteJob', [j.row, expectOf(j)]).then(function (d) { setData(d); toast('삭제했습니다'); }));
    }
    if (a !== 'save') return;
    var service = $('#fService', el).checked;
    var now = {
      date: v('fDate'), client: v('fClient'), director: v('fDirector'), pd: v('fPd'), title: v('fTitle'),
      amount: service ? 0 : digits(v('fAmount')), type: service ? '서비스' : '', quote: v('fQuote'), invoice: v('fInvoice'), paid: v('fPaid'),
      paidAmount: digits(v('fPaidAmount')), paidDate: v('fPaidDate'), incentive: digits(v('fIncentive')), note: v('fNote'), attrYear: digits(v('fAttrYear'))
    };
    var miss = !now.date ? '납품일' : !now.client ? '거래처' : !now.title ? '내용' : (now.amount === '' && !edit) ? '견적금액' : '';
    if (miss) { $('.err', el).textContent = miss + '을(를) 입력해 주세요.'; return; }
    if (!edit) {
      submit(el, call('addJob', [now]).then(function (d) {
        setData(d);
        S.year = Number(now.date.slice(0, 4)); S.tab = 'ledger';
        S.open[S.year + '-' + Number(now.date.slice(5, 7))] = true; saveOpen(); // 등록한 달은 펼쳐서 보이게
        S.q = ''; S.lf = 'all'; render();
        toast('등록했습니다: ' + now.title);
      }));
      return;
    }
    var patch = {}, changed = false;
    Object.keys(now).forEach(function (k) {
      // 화면에서 고칠 수 없는 원래 값(글자로 적힌 날짜·금액)은 건드리지 않습니다.
      var before = j[k];
      if ((k === 'date' || k === 'paidDate') && !isIso(before) && now[k] === '') return;
      if (typeof before === 'string' && before !== '' && typeof now[k] !== 'string' && now[k] === digits(before)) return;
      if (now[k] !== before) { patch[k] = now[k]; changed = true; }
    });
    if (!changed) { closeSheet(); return; }
    submit(el, call('updateJob', [j.row, expectOf(j), patch]).then(function (d) { setData(d); toast('저장했습니다'); }));
  });
  if (!edit) $('#fClient', el).focus();
}

// ---------- 이벤트 ----------
document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.classList && t.classList.contains('money')) { var n = digits(t.value); t.value = n === '' ? '' : won(n); }
  if (t.id === 'q') { S.q = t.value; $('#ledgerList').innerHTML = ledgerList(); }
});
app.addEventListener('click', function (e) {
  var s = e.target.closest('[data-setup]');
  if (s) { setupAction(s.dataset.setup, s); return; }
  if (e.target.closest('[data-retry]')) { app.innerHTML = '<div class="loading">장부를 불러오는 중…</div>'; load(); return; }
  var t = e.target.closest('[data-act],[data-row],[data-lf],[data-uf],[data-us],[data-go],[data-flow],[data-month],[data-months],[data-umonth],[data-umonths]');
  if (!t) return;
  var d = t.dataset;
  if (d.lf) { S.lf = d.lf; render(); return; }
  if (d.month !== undefined) {
    var sec = t.closest('.month');
    S.open[monthKey(d.month)] = !sec.classList.contains('open');
    saveOpen();
    $('#ledgerList').innerHTML = ledgerList();
    return;
  }
  if (d.umonth) {
    S.open[d.umonth] = !t.closest('.month').classList.contains('open');
    saveOpen(); render(); return;
  }
  if (d.umonths) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-umonth]'), function (b) { S.open[b.dataset.umonth] = d.umonths === 'open'; });
    saveOpen(); render(); return;
  }
  if (d.months) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-month]'), function (b) { S.open[monthKey(b.dataset.month)] = d.months === 'open'; });
    saveOpen();
    $('#ledgerList').innerHTML = ledgerList();
    return;
  }
  if (d.uf) { S.uf = d.uf; render(); return; }
  if (d.us) { S.us = d.us; render(); return; }
  if (d.flow) { var top = window.scrollY; S.flow = S.flow === d.flow ? '' : d.flow; render(); window.scrollTo(0, top); return; }
  if (d.go) { var p = d.go.split(':'); S.tab = p[0]; if (p[0] === 'ledger') S.lf = p[1]; else S.uf = p[1]; render(); window.scrollTo(0, 0); return; }
  var j = jobAt(d.row);
  if (!j) return;
  if (d.act === 'invoice') patchJob(j, { invoice: '완료' }, '계산서 발행으로 표시했습니다').catch(function (err) { if (!failed(err).auth) toastError(errText(err)); });
  else if (d.act === 'pay') showPay(j);
  else showDetail(j);
});
$('nav').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b || !S.loaded) return; // 불러오기 전(또는 실패한 화면)에서는 오류 안내를 지우지 않습니다
  S.tab = b.dataset.tab; render(); window.scrollTo(0, 0);
});
$('#year').addEventListener('change', function (e) { if (!S.loaded) return; S.year = Number(e.target.value); render(); });
$('#refresh').addEventListener('click', load);
$('#settings').addEventListener('click', function () { if (S.setup) load(); else showSettings(); });
$('#add').addEventListener('click', function () { if (S.loaded && !S.setup) showForm(null); });
if (window.gz && window.gz.onMenu) window.gz.onMenu(function (action) {
  if (S.setup) return;
  if (action === 'add' && S.loaded && !modal.innerHTML) showForm(null);
  if (action === 'refresh') load();
  // 입력 중인 창이 있으면 단축키로도 확인 없이 닫히지 않습니다.
  if ((action === 'settings' || action === 'update' || action.indexOf('tab:') === 0) && !requestClose()) return;
  if (action === 'settings') showSettings();
  if (action === 'update') { showSettings(); updateAction('check'); }
  if (action === 'sheet' && S.sheetUrl) window.open(S.sheetUrl, '_blank');
  if (action.indexOf('tab:') === 0 && S.loaded) { S.tab = action.slice(4); render(); window.scrollTo(0, 0); }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.id === 'sheetUrl') { var b = $('[data-setup=setSheet]'); if (b) setupAction('setSheet', b); }
});
var resizeTimer = null, escOn = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { if (S.loaded && S.tab === 'home' && !modal.innerHTML) render(); }, 150);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    // 자동완성 목록이 있는 칸: 첫 Esc 는 목록을 닫는 데 쓰이므로 창은 그대로 둡니다(한 번 더 누르면 닫기).
    if (e.target.getAttribute && e.target.getAttribute('list') && e.target.value && escOn !== e.target) { escOn = e.target; return; }
    escOn = null; requestClose(); return;
  }
  escOn = null;
  var t = e.target, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  // Enter: 입력 창에서 저장·등록 (한글 조합 중이거나 메모 칸에서는 제외)
  if (e.key === 'Enter' && !e.isComposing && modal.innerHTML && t.tagName === 'INPUT') {
    var ok = $('.sheet [data-a=save], .sheet [data-a=ok]', modal);
    if (ok && !ok.disabled) { e.preventDefault(); ok.click(); }
    return;
  }
  // ⌘F(Ctrl+F) 또는 / : 장부 검색으로
  if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
    if (!S.loaded || S.setup || modal.innerHTML) return;
    e.preventDefault();
    if (S.tab !== 'ledger') { S.tab = 'ledger'; render(); }
    var q = $('#q'); q.focus(); q.select();
  }
});

load();
call('update:status').then(setUpdate).catch(function () {});
})();
