import { state, on, signin, connectSocket, cnc, light } from './api.js';
import { parseGcode, drawPreview } from './preview.js';

const $ = (id) => document.getElementById(id);
const fmt = (v) => Number(v || 0).toFixed(3);
const fmtMs = (ms) => {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- axis-range guard ----------
// Grbl machine coords run from 0 (home) to -maxTravel on each axis.
// Only trustworthy after homing: before that MPos is arbitrary.
let homedThisConnection = false;
on('read', (line) => {
  // Treat a completed $H (ok after Home) loosely: Grbl zeroes MPos at home.
  if (/^\[MSG:.*[Hh]om/.test(line)) homedThisConnection = true;
});
function travelFor(axis) {
  const key = { X: '$130', Y: '$131', Z: '$132' }[axis];
  const v = Number(state.settings[key]);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function jogWithinRange(axis, step) {
  const travel = travelFor(axis);
  if (travel === null) return { ok: true, warn: 'travel limits unknown — no range check' };
  if (!homedThisConnection) return { ok: true, warn: 'machine not homed this connection — range check unreliable' };
  const current = Number(state.mpos[axis.toLowerCase()]);
  const target = current + step;
  // allow a small margin off the exact envelope
  if (target > 0.5 || target < -(travel + 0.5)) {
    return { ok: false, warn: `jog ${axis}${step > 0 ? '+' : ''}${step} would exceed travel (MPos ${current.toFixed(1)}, limit 0…-${travel})` };
  }
  return { ok: true };
}

// ---------- mode switching ----------
let mode = 'monitor';
function setMode(next) {
  mode = next;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === next));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + next));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

on('workflow', (w) => {
  if (w === 'running' && mode !== 'run') { setMode('run'); toast('Job started — Run mode'); }
  if (w === 'idle' && mode === 'run') setMode('monitor');
});
on('blocked', () => toast('Blocked: line contained "(" — S5Pro firmware would hang'));

// ---------- top bar ----------
function renderTop() {
  $('conn-dot').className = 'dot ' + (state.connected ? 'on' : 'off');
  $('port-label').textContent = state.port || 'no port';
  const b = $('state-badge');
  const s = state.activeState;
  b.textContent = s;
  b.className = 'badge ' + (
    s === 'Idle' ? 'idle' : s === 'Run' || s === 'Jog' ? 'run' :
    String(s).startsWith('Hold') ? 'hold' : s === 'Alarm' ? 'alarm' : '');
}
on('conn', renderTop); on('port', renderTop); on('state', renderTop);

// ---------- monitor ----------
function renderMonitor() {
  $('mon-state').textContent = state.activeState;
  $('mon-workflow').textContent = 'workflow: ' + state.workflow;
  $('mon-wx').textContent = fmt(state.wpos.x); $('mon-mx').textContent = fmt(state.mpos.x);
  $('mon-wy').textContent = fmt(state.wpos.y); $('mon-my').textContent = fmt(state.mpos.y);
  $('mon-wz').textContent = fmt(state.wpos.z); $('mon-mz').textContent = fmt(state.mpos.z);
  $('mon-feed').textContent = state.feedrate;
  $('mon-spindle').textContent = state.spindle;
  $('mon-ov').textContent = state.ov.join(' / ') + ' %';
  const sender = state.sender;
  $('mon-file').textContent = state.gcodeName || 'none';
  const pct = sender && sender.total ? (100 * sender.sent / sender.total) : 0;
  $('mon-prog').style.width = pct + '%';
  $('mon-pct').textContent = sender && sender.total ? `${pct.toFixed(1)}% (${sender.sent}/${sender.total})` : '—';
}
on('state', renderMonitor); on('sender', renderMonitor); on('workflow', renderMonitor); on('gcode', renderMonitor);

// light widget
let lightState = null;
async function refreshLight() {
  try {
    lightState = await light.get();
    $('light-toggle').textContent = lightState.on ? 'Turn off' : 'Turn on';
    $('light-bri').value = lightState.brightness;
    $('light-temp').value = 487 - lightState.temperature; // invert slider: left=warm
    $('light-status').textContent =
      `${lightState.on ? 'on' : 'off'} · ${lightState.brightness}% · ~${Math.round(1e6 / lightState.temperature / 50) * 50}K`;
  } catch {
    $('light-status').textContent = 'light unreachable';
  }
}
$('light-toggle').addEventListener('click', async () => {
  if (!lightState) return;
  try { await light.set({ on: lightState.on ? 0 : 1 }); } catch { toast('Light unreachable'); }
  refreshLight();
});
$('light-bri').addEventListener('change', async (e) => { try { await light.set({ on: 1, brightness: Number(e.target.value) }); } catch {} refreshLight(); });
$('light-temp').addEventListener('change', async (e) => { try { await light.set({ on: 1, temperature: 487 - Number(e.target.value) }); } catch {} refreshLight(); });
setInterval(refreshLight, 10000);

// ---------- prep ----------
let parsed = null;
let gcodeText = '';
function redraw() {
  drawPreview($('preview'), parsed, parsed ? { x: Number(state.wpos.x), y: Number(state.wpos.y) } : null);
}
$('gcode-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  gcodeText = await file.text();
  parsed = parseGcode(gcodeText);
  $('prep-file').textContent = file.name;
  $('prep-lines').textContent = gcodeText.split('\n').length;
  $('prep-extents').textContent = parsed.segs.length
    ? `X ${parsed.minX.toFixed(1)}…${parsed.maxX.toFixed(1)}  Y ${parsed.minY.toFixed(1)}…${parsed.maxY.toFixed(1)}  Z ${parsed.minZ.toFixed(1)}…${parsed.maxZ.toFixed(1)}`
    : 'no motion found';
  $('prep-paren-warn').classList.toggle('hidden', !gcodeText.includes('('));
  cnc.loadGcode(file.name, gcodeText);
  toast(`Loaded ${file.name} into sender`);
  redraw();
});
on('state', () => { if (mode === 'prep') redraw(); });

document.querySelectorAll('[data-jog]').forEach((b) => b.addEventListener('click', () => {
  const [axis, dir] = b.dataset.jog.split(',');
  const step = Number($('jog-step').value) * Number(dir);
  const feed = Number($('jog-feed').value);
  const check = jogWithinRange(axis, step);
  if (!check.ok) { toast('⛔ ' + check.warn); return; }
  if (check.warn) toast('⚠ ' + check.warn);
  cnc.gcode(`$J=G91 G21 ${axis}${step} F${feed}`);
}));
$('jog-cancel').addEventListener('click', () => cnc.jogCancel());
document.querySelectorAll('[data-zero]').forEach((b) => b.addEventListener('click', () => {
  const axes = b.dataset.zero.split('').map((a) => `${a}0`).join(' ');
  cnc.gcode(`G10 L20 P1 ${axes}`);
  toast(`Work zero set: ${b.dataset.zero}`);
}));
$('home-btn').addEventListener('click', () => {
  if (confirm('Run homing cycle ($H)?')) { cnc.home(); homedThisConnection = true; }
});
$('unlock-btn').addEventListener('click', () => cnc.unlock());

// ---------- run ----------
function renderRun() {
  $('run-state').textContent = state.activeState;
  $('run-wx').textContent = fmt(state.wpos.x);
  $('run-wy').textContent = fmt(state.wpos.y);
  $('run-wz').textContent = fmt(state.wpos.z);
  $('ov-feed').textContent = state.ov[0] + '%';
  $('ov-spindle').textContent = state.ov[2] + '%';
  const s = state.sender;
  $('run-file').textContent = state.gcodeName || 'no file';
  const pct = s && s.total ? (100 * s.sent / s.total) : 0;
  $('run-prog').style.width = pct + '%';
  $('run-pct').textContent = s && s.total ? pct.toFixed(1) + '%' : '—';
  $('run-elapsed').textContent = s ? fmtMs(s.elapsedTime) : '—';
  $('run-remaining').textContent = s ? fmtMs(s.remainingTime) : '—';
}
on('state', renderRun); on('sender', renderRun); on('gcode', renderRun);

$('run-start').addEventListener('click', () => {
  if (!state.gcodeName) return toast('No G-code loaded — use Prep');
  // pre-flight: toolpath extents vs machine travel (work-zero relative, so
  // this is advisory — firmware soft limits are the hard boundary)
  if (parsed && parsed.segs.length) {
    const tx = travelFor('X'), ty = travelFor('Y');
    if ((tx && parsed.maxX - parsed.minX > tx) || (ty && parsed.maxY - parsed.minY > ty)) {
      if (!confirm('⚠ Toolpath extents exceed machine travel. Start anyway?')) return;
    }
  }
  if (confirm(`Start job "${state.gcodeName}"?`)) cnc.start();
});
$('run-hold').addEventListener('click', () => cnc.feedhold());
$('run-resume').addEventListener('click', () => cnc.cyclestart());
$('run-stop').addEventListener('click', () => confirm('Stop the job (soft reset)?') && cnc.stop());
document.querySelectorAll('[data-ov]').forEach((b) => b.addEventListener('click', () => {
  const [which, v] = b.dataset.ov.split(',');
  (which === 'feed' ? cnc.feedOverride : cnc.spindleOverride)(Number(v));
}));

// ---------- config ----------
$('cfg-refresh').addEventListener('click', () => cnc.listPorts());
on('ports', (ports) => {
  $('cfg-port').innerHTML = ports
    .map((p) => `<option ${p.inuse ? 'selected' : ''}>${p.port}</option>`).join('');
});
$('cfg-open').addEventListener('click', () => cnc.openPort($('cfg-port').value, $('cfg-baud').value));
$('cfg-close').addEventListener('click', () => cnc.closePort());
on('port', () => { $('cfg-ctl').textContent = state.controllerType || '—'; });

const GRBL_DESC = {
  $0: 'step pulse µs', $1: 'step idle delay', $2: 'step invert', $3: 'dir invert', $4: 'step enable invert',
  $5: 'limit invert', $6: 'probe invert', $10: 'status report mask', $11: 'junction deviation', $12: 'arc tolerance',
  $13: 'report inches', $20: 'soft limits', $21: 'hard limits', $22: 'homing enable', $23: 'homing dir invert',
  $24: 'homing feed', $25: 'homing seek', $26: 'homing debounce', $27: 'homing pull-off', $30: 'max spindle rpm',
  $31: 'min spindle rpm', $32: 'laser mode', $100: 'X steps/mm', $101: 'Y steps/mm', $102: 'Z steps/mm',
  $110: 'X max rate', $111: 'Y max rate', $112: 'Z max rate', $120: 'X accel', $121: 'Y accel', $122: 'Z accel',
  $130: 'X max travel', $131: 'Y max travel', $132: 'Z max travel',
};
function renderSettings() {
  const tbody = $('cfg-settings').querySelector('tbody');
  tbody.innerHTML = Object.entries(state.settings)
    .map(([k, v]) => `<tr><td>${k}</td><td class="val" data-k="${k}">${v}</td><td class="desc">${GRBL_DESC[k] || ''}</td></tr>`)
    .join('');
  tbody.querySelectorAll('.val').forEach((td) => td.addEventListener('click', () => {
    const k = td.dataset.k;
    const nv = prompt(`${k} (${GRBL_DESC[k] || 'setting'}) = ?`, td.textContent);
    if (nv !== null && nv.trim() !== '' && confirm(`Write ${k}=${nv.trim()} to the controller?`)) {
      cnc.gcode(`${k}=${nv.trim()}`);
    }
  }));
}
on('settings', renderSettings);

// ---------- diagnose ----------
const consoleOut = $('console-out');
function logLine(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  consoleOut.appendChild(span);
  while (consoleOut.childNodes.length > 400) consoleOut.removeChild(consoleOut.firstChild);
  consoleOut.scrollTop = consoleOut.scrollHeight;
}
const ALARMS = {
  1: 'Hard limit triggered', 2: 'Motion exceeds travel (soft limit)', 3: 'Reset while in motion',
  4: 'Probe fail: not in expected state', 5: 'Probe fail: no contact', 6: 'Homing fail: reset',
  7: 'Homing fail: door opened', 8: 'Homing fail: pull-off', 9: 'Homing fail: switch not found',
};
on('read', (line) => {
  logLine(line, /^(error|ALARM)/i.test(line) ? 'err' : '');
  const m = String(line).match(/^ALARM:(\d+)/);
  if (m) $('diag-alarm').textContent = `ALARM:${m[1]} — ${ALARMS[m[1]] || 'unknown'}`;
});
on('write', (data) => logLine('> ' + data, 'tx'));
function sendConsole() {
  const input = $('console-in');
  const line = input.value.trim();
  if (!line) return;
  if (line.includes('(')) { $('console-warn').classList.remove('hidden'); return; }
  $('console-warn').classList.add('hidden');
  if (line === '?') cnc.statusQuery('?'); else cnc.gcode(line);
  input.value = '';
}
$('console-send').addEventListener('click', sendConsole);
$('console-in').addEventListener('keydown', (e) => e.key === 'Enter' && sendConsole());
$('diag-unlock').addEventListener('click', () => cnc.unlock());
$('diag-home').addEventListener('click', () => confirm('Run homing cycle ($H)?') && cnc.home());
$('diag-reset').addEventListener('click', () => confirm('Soft reset (Ctrl-X)? Stops everything.') && cnc.reset());
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => cnc.statusQuery(b.dataset.q)));

// ---------- boot ----------
(async function boot() {
  try {
    await signin();
    await connectSocket();
    cnc.listPorts();
    refreshLight();
    renderTop();
    toast('Connected');
  } catch (e) {
    toast('Startup failed: ' + e.message);
  }
})();
