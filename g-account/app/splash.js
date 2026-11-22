// GRAYZONE 런치 화면. 앱 본체가 보내 주는 상태({ version, filled, text })를 보여 주기만 합니다.
(function () {
  'use strict';
  // 존 0 → X 의 회색 값 (규격)
  var GRAYS = ['#000000', '#1B1B1B', '#303030', '#474747', '#5E5E5E', '#777777', '#919191', '#ABABAB', '#C6C6C6', '#E0E0E0', '#FFFFFF'];
  var ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  // 이 앱의 존 번호: IX (왼쪽에서 10번째 칸). G-Copy III · G-Looks V · G-Retag VII · G-Account IX
  var APP_ZONE = 9;

  var $ = function (id) { return document.getElementById(id); };
  var cells = $('cells'), zones = $('zones');
  GRAYS.forEach(function (g, i) {
    var c = document.createElement('div');
    c.className = 'cell' + (i === 0 ? ' z0' : '') + (i === APP_ZONE ? ' mine' : '');
    c.style.setProperty('--v', g);
    cells.appendChild(c);
    var z = document.createElement('span');
    z.textContent = i === APP_ZONE ? ROMAN[i] : '';
    zones.appendChild(z);
  });
  zones.hidden = APP_ZONE === null;

  var failed = false;
  function render(s) {
    if (s.version) $('ver').textContent = s.version;
    $('msg').textContent = s.text || '';
    // 오류로 멈춘 상태: 문구를 #E8E8E8 로 올리고, 클릭하거나 키를 누르면 앱을 끝냅니다.
    if (s.failed && !failed) {
      failed = true;
      $('msg').style.color = '#E8E8E8';
      document.body.style.webkitAppRegion = 'no-drag'; // 끌기 영역은 클릭을 받지 못합니다
      var quit = function () { if (window.gzSplash && window.gzSplash.quit) window.gzSplash.quit(); };
      document.addEventListener('click', quit);
      document.addEventListener('keydown', quit);
    }
    // 오류 문구가 길어도 끝의 닫는 방법 안내는 항상 보이게, 괄호 안의 원인을 줄입니다.
    if (s.failed) {
      var m = /^(.*?\()(.*)(\)\. [^)]*)$/.exec(s.text || ''), el = $('msg');
      for (var cause = m ? m[2] : ''; m && el.scrollWidth > el.clientWidth && cause.length > 1;) {
        cause = cause.slice(0, -2);
        el.textContent = m[1] + cause + '…' + m[3];
      }
    }
    var n = Math.max(0, Math.min(11, s.filled || 0));
    for (var i = 0; i < 11; i++) cells.children[i].classList.toggle('on', i < n);
  }

  if (window.gzSplash) window.gzSplash.onState(render);
  window.__render = render; // 테스트용
})();
