'use strict';
// The launch screen's page. It only draws what the app tells it:
// window.splash.onState({ name, version, icon, zone, done, status }).
const GRAYS = ['#000000', '#1B1B1B', '#303030', '#474747', '#5E5E5E', '#777777', '#919191', '#ABABAB', '#C6C6C6', '#E0E0E0', '#FFFFFF'];
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const wedge = document.getElementById('wedge');
const zones = document.getElementById('zones');
const cells = GRAYS.map((g, i) => {
  const c = document.createElement('i');
  c.style.setProperty('--g', g);
  if (i === 0) c.classList.add('z0');
  wedge.append(c);
  zones.append(document.createElement('span'));
  return c;
});

function render(s) {
  if (s.name != null) document.getElementById('app-name').textContent = s.name;
  if (s.version != null) document.getElementById('version').textContent = s.version;
  if (s.icon && !document.getElementById('icon').getAttribute('src')) document.getElementById('icon').src = s.icon;
  if (Number.isInteger(s.zone)) {
    cells.forEach((c, i) => c.classList.toggle('own', i === s.zone));
    [...zones.children].forEach((z, i) => { z.textContent = i === s.zone ? ROMAN[i] : ''; });
  }
  if (Number.isInteger(s.done)) cells.forEach((c, i) => c.classList.toggle('on', i < s.done));
  if (s.status != null) document.getElementById('status').textContent = s.status;
  document.body.classList.toggle('failed', !!s.failed);
  failed = !!s.failed;
}
// After a failed start, a click or a key closes the app.
let failed = false;
const closeIfFailed = () => { if (failed && window.splash) window.splash.close(); };
window.addEventListener('click', closeIfFailed);
window.addEventListener('keydown', closeIfFailed);
window.renderSplash = render; // also used by the tests
// Say "ready" (the window is shown then) only once the embedded fonts are
// in, so the screen never appears in a fallback font first.
const fonts = Promise.all([document.fonts.load('400 18px Pretendard'), document.fonts.load('600 52px Manrope')]).catch(() => {});
fonts.then(() => { if (window.splash) window.splash.onState(render); });
