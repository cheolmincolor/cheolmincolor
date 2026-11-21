// 앱을 열 때 먼저 뜨는 「업데이트 확인」 창. 앱 본체가 보내 주는 상태를 보여 주기만 합니다.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var api = window.gzSplash;

  function render(s) {
    var msg = $('msg'), track = $('track'), fill = $('fill'), acts = $('acts');
    if (s.current) $('ver').textContent = '버전 ' + s.current;
    var text = '', bar = 'indet', pct = 0, buttons = '', err = false;
    var v = s.latest ? ' ' + s.latest : '';
    switch (s.stage || s.status) {
      case 'checking': text = '업데이트를 확인하고 있습니다…'; buttons = 'skip'; break;
      case 'available': text = '새 버전' + v + '이 있습니다. 받을 준비를 합니다…'; buttons = 'skip'; break;
      case 'downloading': text = '새 버전' + v + '을 받는 중… ' + (s.progress || 0) + '%'; bar = 'pct'; pct = s.progress || 0; buttons = 'skip'; break;
      case 'ready': case 'installing': case 'install': text = '새 버전' + v + '을 설치하고 다시 시작합니다…'; bar = 'pct'; pct = 100; break;
      case 'none': text = '최신 버전입니다. 장부를 엽니다…'; bar = 'pct'; pct = 100; break;
      case 'unsupported': text = (s.error || '이 컴퓨터에서는 자동 업데이트를 할 수 없습니다.') + ' 장부를 엽니다…'; bar = 'pct'; pct = 100; break;
      case 'error': text = '업데이트를 확인하지 못했습니다. 장부를 엽니다…'; bar = 'pct'; pct = 100; err = true; break;
      case 'install-error': text = s.error || '업데이트를 설치하지 못했습니다.'; bar = 'none'; buttons = 'open'; err = true; break;
      default: text = '업데이트를 확인하고 있습니다…';
    }
    msg.textContent = text;
    msg.className = err ? 'err' : '';
    track.hidden = bar === 'none';
    track.className = 'track' + (bar === 'indet' ? ' indet' : '');
    fill.style.width = bar === 'pct' ? pct + '%' : '';
    var html = buttons === 'skip' ? '<button id="skip">업데이트 건너뛰고 열기</button>'
      : buttons === 'open' ? '<button class="pri" id="skip">장부 열기</button>' : '';
    if (acts.innerHTML !== html) acts.innerHTML = html;
    var b = $('skip');
    if (b) b.onclick = function () { b.disabled = true; api.skip(); };
  }

  if (api) api.onState(render);
})();
