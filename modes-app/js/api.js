// Connection + state layer: signin, socket.io, REST, Elgato light proxy.
// All traffic stays on this host (server is bound to 127.0.0.1).

export const state = {
  token: null,
  socket: null,
  connected: false,      // socket to server
  port: null,            // serial port currently open (null = none)
  controllerType: null,
  activeState: '—',      // Grbl: Idle/Run/Hold/Alarm/Jog/...
  workflow: 'idle',
  wpos: { x: '0.000', y: '0.000', z: '0.000' },
  mpos: { x: '0.000', y: '0.000', z: '0.000' },
  feedrate: 0,
  spindle: 0,
  ov: [100, 100, 100],
  settings: {},          // $$ map
  sender: null,          // sender status (job progress)
  gcodeName: null,
  listeners: {},
};

export function on(event, fn) {
  (state.listeners[event] = state.listeners[event] || []).push(fn);
}
function emit(event, ...args) {
  (state.listeners[event] || []).forEach((fn) => fn(...args));
}

export async function signin() {
  const res = await fetch('api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json();
  if (!data.token) throw new Error('signin failed (users configured? sign in via legacy UI first)');
  state.token = data.token;
  return data.token;
}

export function connectSocket() {
  const socket = io(location.origin, { query: 'token=' + state.token });
  state.socket = socket;

  socket.on('connect', () => { state.connected = true; emit('conn'); });
  socket.on('disconnect', () => { state.connected = false; state.port = null; emit('conn'); });

  socket.on('serialport:open', (o) => {
    state.port = o.port; state.controllerType = o.controllerType; emit('port');
  });
  socket.on('serialport:close', () => { state.port = null; emit('port'); });
  socket.on('serialport:list', (ports) => emit('ports', ports || []));

  socket.on('controller:state', (type, s) => {
    const st = s && s.status;
    if (st) {
      state.activeState = st.activeState || '—';
      if (st.wpos) state.wpos = st.wpos;
      if (st.mpos) state.mpos = st.mpos;
      state.feedrate = st.feedrate ?? state.feedrate;
      state.spindle = st.spindle ?? state.spindle;
      if (st.ov) state.ov = st.ov;
    }
    emit('state');
  });
  socket.on('controller:settings', (type, s) => {
    state.settings = (s && s.settings) || {};
    emit('settings');
  });
  socket.on('workflow:state', (w) => { state.workflow = w; emit('workflow', w); });
  socket.on('sender:status', (s) => { state.sender = s; if (s && s.name) state.gcodeName = s.name; emit('sender'); });
  socket.on('gcode:load', (name) => { state.gcodeName = name; emit('gcode'); });
  socket.on('serialport:read', (line) => emit('read', line));
  socket.on('serialport:write', (data) => emit('write', String(data).trimEnd()));

  return new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', (e) => reject(new Error('socket: ' + e.message)));
  });
}

// ---- machine commands (all via the running server) ----
export const cnc = {
  listPorts: () => state.socket.emit('list'),
  openPort: (port, baudrate) => state.socket.emit('open', port, { controllerType: 'Grbl', baudrate: Number(baudrate) || 115200 }),
  closePort: () => state.port && state.socket.emit('close', state.port),
  command: (cmd, ...args) => state.port && state.socket.emit('command', state.port, cmd, ...args),
  // Single G-code/system line. HARD GUARD: the S5Pro firmware hangs on "(".
  gcode(line) {
    if (String(line).includes('(')) { emit('blocked', line); return false; }
    this.command('gcode', line);
    return true;
  },
  loadGcode(name, content) { this.command('gcode:load', name, content); },
  start: () => cnc.command('gcode:start'),
  pause: () => cnc.command('gcode:pause'),
  resume: () => cnc.command('gcode:resume'),
  stop: () => cnc.command('gcode:stop', { force: true }),
  feedhold: () => cnc.command('feedhold'),
  cyclestart: () => cnc.command('cyclestart'),
  home: () => cnc.command('homing'),
  unlock: () => cnc.command('unlock'),
  reset: () => cnc.command('reset'),
  jogCancel: () => cnc.command('jogCancel'),
  feedOverride: (v) => cnc.command('feedOverride', v),
  spindleOverride: (v) => cnc.command('spindleOverride', v),
  statusQuery: (q) => state.port && state.socket.emit('write', state.port, q === '?' ? '?' : q + '\n'),
};

// ---- shop light (server-side proxy avoids CORS) ----
export const light = {
  async get() {
    const r = await fetch('light');
    if (!r.ok) throw new Error('light unreachable');
    return (await r.json()).lights[0];
  },
  async set(props) {
    const r = await fetch('light', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numberOfLights: 1, lights: [props] }),
    });
    if (!r.ok) throw new Error('light unreachable');
    return (await r.json()).lights[0];
  },
};
