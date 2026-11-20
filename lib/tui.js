'use strict';
// Full-screen tabbed terminal UI (`sht` with no arguments).
//   [! n] notification button │ 1 Overview │ 2 Ports │ 3 Services │ 4 Alerts │ 5 Processes
// Mouse: click tabs / the button, wheel scrolls. Keys: 1-5 ←/→ tabs, ↑/↓ PgUp/PgDn scroll,
// / command line, a alerts, e ephemeral ports, s sort processes, q quit.
const util = require('node:util');
const { spawnSync } = require('node:child_process');
const C = require('./config');
const { run, COMMANDS, serviceState, helpText } = require('./commands');
const { openSource } = require('./source');
const { ProcSampler } = require('./procs');
const { tokenize } = require('./repl');
const { issues: currentIssues } = require('./issues');

// ---------- ansi helpers ----------
const E = '\x1b[';
const sgr = (code) => (s) => `${E}${code}m${s}${E}0m`;
const bold = sgr(1), dim = sgr(2), red = sgr(31), green = sgr(32), yellow = sgr(33), cyan = sgr(36), inv = sgr(7);
const bgRed = sgr('1;37;41'), bgYellow = sgr('1;30;43'), bgGreen = sgr('30;42'), tabOn = sgr('1;30;46');
const COLOR = { ok: green, warn: yellow, crit: red };
const ICON = { ok: green('✓'), warn: yellow('!'), crit: red('×') };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/y;

function fit(str, w) {
  if (w <= 0) return '';
  let out = '', vis = 0, i = 0;
  const s = String(str);
  while (i < s.length && vis < w) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    out += ch; i += ch.length; vis++;
  }
  return out + `${E}0m` + ' '.repeat(Math.max(0, w - vis));
}
const vlen = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
const bytes = (n) => {
  const u = ['B', 'K', 'M', 'G', 'T']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)}${u[i]}`;
};
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
};
const SPARK = '▁▂▃▄▅▆▇█';
function spark(values, w, max) {
  const v = values.slice(-w);
  const top = max ?? Math.max(1, ...v);
  return v.map((x) => SPARK[Math.min(7, Math.max(0, Math.round((x / top) * 7)))]).join('').padStart(w, ' ');
}
function bar(pct, w, status = 'ok') {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w);
  return (status === 'ok' ? cyan : COLOR[status])('█'.repeat(n)) + dim('░'.repeat(Math.max(0, w - n)));
}
const pctColor = (p) => (p >= 90 ? red : p >= 70 ? yellow : (s) => s);
const section = (title, w, extra = '') => {
  const t = ` ${title} `;
  return cyan('─') + bold(cyan(t)) + dim(extra) + cyan('─'.repeat(Math.max(0, w - 1 - t.length - vlen(extra))));
};
const clock = (t = Date.now()) => new Date(t).toLocaleTimeString();
const PIN = cyan('▲');

// text-like columns sort A→Z first; numbers (cpu, memory…) sort biggest first
const ASC_FIRST = new Set(['port', 'pid', 'name', 'unit', 'process', 'state', 'description', 'bind']);
const TABS = ['Overview', 'Ports', 'Services', 'Alerts', 'Processes'];

// ---------- the app ----------
async function tui(baseOpts = {}) {
  const out = process.stdout;
  const stdin = process.stdin;
  let cfg = C.loadConfig(baseOpts.config);
  const procs = new ProcSampler();
  let procRows = [];
  let tab = 0;
  const scroll = [0, 0, 0, 0, 0];
  let showEphemeral = true;
  // client-side sorting per table: click a header, or s (next column) / r (reverse)
  const sorts = { Ports: { key: 'port', dir: 1 }, Services: { key: 'cpu', dir: -1 }, Processes: { key: 'cpu', dir: -1 } };
  let headerHits = null;   // { y, hits: [{x0, x1, key}] } for the visible table
  let cmdMode = false;
  let input = '';
  let message = '';
  let pager = null;
  let suspended = false;
  let svc = serviceState();
  const history = [];
  let histIdx = -1;
  let busy = false;
  let hits = [];        // clickable regions on the tab bar
  let seenAlerts = 0;   // history length when the Alerts tab was last opened
  let renderTimer = null, lastRender = 0;

  const origLog = console.log;
  let capture = null;
  console.log = (...a) => {
    if (capture) capture.push(...util.format(...a).split('\n'));
    else if (suspended) origLog(...a);
  };

  const MOUSE_ON = `${E}?1000h${E}?1006h`, MOUSE_OFF = `${E}?1000l${E}?1006l`;
  const enter = () => { out.write(`${E}?1049h${E}?25l${MOUSE_ON}`); if (stdin.isTTY) stdin.setRawMode(true); stdin.resume(); };
  const leave = () => { out.write(`${MOUSE_OFF}${E}?25h${E}?1049l`); if (stdin.isTTY) stdin.setRawMode(false); };
  const quit = () => { try { src?.stop(); } catch { /* ignore */ } leave(); console.log = origLog; process.exit(0); };
  process.on('uncaughtException', (e) => { leave(); console.log = origLog; console.error(e); process.exit(1); });

  // ----- data -----
  let src = null;
  const onUpdate = () => schedule();
  src = await openSource(cfg, { onUpdate });

  let procTimer = null;
  const sampleProcs = async () => {
    try {
      procRows = await procs.sample();
      schedule();
    } catch { /* ignore */ }
  };
  // processes are sampled only while their tab is open
  function setTab(n) {
    tab = (n + TABS.length) % TABS.length;
    clearInterval(procTimer); procTimer = null;
    if (TABS[tab] === 'Processes') {
      sampleProcs(); setTimeout(sampleProcs, 700);
      procTimer = setInterval(sampleProcs, Math.max(1000, cfg.sampleMs));
    }
    if (TABS[tab] === 'Alerts') seenAlerts = src.alerts.length;
    render();
  }
  const svcTimer = setInterval(() => { svc = serviceState(); }, 10000);

  // the clock ticks every second, independent of the sampling rate
  let clockTimer = null;
  const tick = () => {
    if (!suspended && !pager) drawTabBar();
    clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };

  // ----- render -----
  function schedule() {
    if (suspended) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, Math.max(0, 40 - (Date.now() - lastRender)));
  }

  function tabBar(W) {
    const s = src.state;
    const list = currentIssues(s);
    const worst = list.some((i) => i.level === 'crit') ? 'crit' : list.length ? 'warn' : 'ok';
    const unseen = src.alerts.length > seenAlerts && tab !== 3;
    const label = list.length ? ` ! ${list.length}${unseen ? '•' : ''} ` : ` ✓ 0${unseen ? '•' : ''} `;
    const badge = worst === 'crit' ? bgRed(label) : worst === 'warn' ? bgYellow(label) : bgGreen(label);
    hits = [];
    let x = 1;
    let line = badge;
    hits.push({ x0: x, x1: x + label.length - 1, tab: 3 });
    x += label.length;
    line += ' ';
    x += 1;
    TABS.forEach((name, i) => {
      const t = ` ${i + 1} ${name} `;
      line += i === tab ? tabOn(t) : dim(t);
      hits.push({ x0: x, x1: x + t.length - 1, tab: i });
      x += t.length;
    });
    const room = W - vlen(line) - 1;
    const options = [];
    if (s) {
      const st = { ok: green('● healthy'), warn: yellow('● warning'), crit: red('● critical') }[s.status];
      const url = cfg.web === false ? 'web off' : `${cfg.host}:${cfg.port}`;
      const svcName = svc === 'active' ? green('service') : src.kind === 'daemon' ? cyan('dev daemon')
        : svc === 'not installed' ? yellow('no service') : yellow(`service ${svc}`);
      // most detailed first; drop parts until it fits, the clock always stays
      options.push(`${bold(s.host)} ${st} ${dim('·')} ${svcName} ${dim(url)} ${dim('·')} ${clock()} `);
      options.push(`${bold(s.host)} ${st} ${dim('·')} ${svcName} ${dim('·')} ${clock()} `);
      options.push(`${bold(s.host)} ${st} ${dim('·')} ${clock()} `);
      options.push(`${st} ${clock()} `);
    }
    options.push(`${clock()} `);
    const right = options.find((o) => vlen(o) <= room);
    return right ? line + ' '.repeat(W - vlen(line) - vlen(right)) + right : fit(line, W);
  }
  function drawTabBar() {
    const W = out.columns || 80;
    out.write(`${E}s${E}1;1H${fit(tabBar(W), W)}${E}u`);
  }

  async function render() {
    if (suspended) return;
    lastRender = Date.now();
    const W = out.columns || 80, H = out.rows || 24;
    let lines;
    if (pager) lines = renderPager(W, H);
    else {
      const body = H - 3; // tab bar + message + command line
      const { fixed = [], rows = [], hits, headerIndex } = await content(W, body);
      headerHits = hits ? { y: 2 + headerIndex, hits } : null;
      const room = Math.max(0, body - fixed.length);
      scroll[tab] = Math.max(0, Math.min(scroll[tab], Math.max(0, rows.length - room)));
      const visible = rows.slice(scroll[tab], scroll[tab] + room);
      if (TABS[tab] === 'Processes') await procs.details(visible.map((r) => r.proc).filter(Boolean));
      lines = [tabBar(W), ...fixed, ...visible.map((r) => (typeof r === 'string' ? r : r.render()))];
      while (lines.length < H - 2) lines.push('');
      lines.length = H - 2;
      const more = rows.length > room ? dim(`  ${scroll[tab] + 1}-${Math.min(rows.length, scroll[tab] + room)} of ${rows.length}`) : '';
      lines.push((message || hint()) + more);
      lines.push(cmdMode ? `${cyan('sht›')} ${input}` : dim(' / command  ·  1-5 or ←/→ tabs  ·  ↑/↓ PgUp/PgDn scroll  ·  ? help  ·  q quit'));
    }
    let buf = '';
    for (let i = 0; i < H; i++) buf += `${E}${i + 1};1H${fit(lines[i] ?? '', W)}`;
    buf += cmdMode && !pager ? `${E}${H};${Math.min(W, 6 + input.length)}H${E}?25h` : `${E}?25l`;
    out.write(buf);
  }

  function hint() {
    return dim({
      Overview: ' machine usage, network and storage',
      Ports: ` click a header or s/r to sort · ${PIN} pinned first · e ${showEphemeral ? 'hides' : 'shows'} ephemeral · /pin <port> · /alias <port> <name>`,
      Services: ` click a header or s/r to sort · ${PIN} pinned first · /pin unit:<name> · /alias unit:<name> <label>`,
      Alerts: ' current warnings & errors, then the history of status changes',
      Processes: ` click a header or s/r to sort · ${PIN} pinned first · /alias proc:<name> <label>`,
    }[TABS[tab]]);
  }

  function renderPager(W, H) {
    const body = H - 2;
    pager.offset = Math.max(0, Math.min(pager.offset, pager.lines.length - body));
    const lines = [inv(fit(` ${pager.title}  ·  ↑/↓ PgUp/PgDn scroll · q/Esc/Enter close `, W))];
    for (let i = 0; i < body; i++) lines.push(pager.lines[pager.offset + i] ?? '');
    lines.push(dim(`${Math.min(pager.lines.length, pager.offset + body)}/${pager.lines.length} lines`));
    return lines;
  }

  // ----- tab contents: { fixed: [lines], rows: [lines | {render, proc}] } -----
  async function content(W, body) {
    const s = src.state;
    if (!s) return { fixed: ['', ' collecting…'] };
    switch (TABS[tab]) {
      case 'Overview': return { rows: overview(s, W) };
      case 'Ports': return ports(s, W);
      case 'Services': return services(s, W);
      case 'Alerts': return alerts(s, W);
      default: return processes(s, W);
    }
  }

  function overview(s, W) {
    const hist = src.history;
    const two = W >= 110;
    const lw = two ? Math.floor((W - 1) / 2) : W;
    const rw = two ? W - lw - 1 : W;
    const barW = Math.max(10, Math.min(30, lw - 40));
    const sparkW = Math.max(8, lw - barW - 20);
    const left = [section('Usage', lw, ` up ${duration(s.uptime)} · ${s.platform} `)];
    left.push(` CPU  ${bar(s.cpu.usage, barW, s.cpu.status)} ${s.cpu.usage.toFixed(1).padStart(5)}%  ${cyan(spark(hist.map((h) => h.cpu), sparkW, 100))}`);
    const per = Math.max(1, Math.floor((lw - 6) / 10));
    for (let i = 0; i < s.cpu.cores.length; i += per) {
      left.push(`      ${s.cpu.cores.slice(i, i + per).map((c, j) => `${dim(`#${i + j}`)} ${pctColor(c)(c.toFixed(0).padStart(3))}%`).join('  ')}`);
    }
    left.push(` ${dim(fit(s.cpu.model || '', lw - 2))}`);
    left.push(` MEM  ${bar(s.memory.percent, barW, s.memory.status)} ${s.memory.percent.toFixed(1).padStart(5)}%  ${cyan(spark(hist.map((h) => h.mem), sparkW, 100))}`);
    left.push(`      ${bytes(s.memory.used)} used · ${bytes(s.memory.available)} available · ${bytes(s.memory.cached)} cache · ${bytes(s.memory.total)} total`);
    const sw = s.memory.swap;
    left.push(sw.total ? ` SWAP ${bar(sw.percent, barW, sw.status)} ${sw.percent.toFixed(1).padStart(5)}%  ${dim(`${bytes(sw.used)} / ${bytes(sw.total)}`)}` : ` SWAP ${dim('none')}`);
    left.push(` LOAD ${s.load.l1.toFixed(2)}  ${s.load.l5.toFixed(2)}  ${s.load.l15.toFixed(2)}  ${dim(`1/5/15 min · ${s.load.perCore} per core (5 min) · ${s.load.cores} cores`)} ${ICON[s.load.status]}`);
    const temps = [...s.temps.list].sort((a, b) => b.celsius - a.celsius).slice(0, 4);
    left.push(` TEMP ${temps.length ? temps.map((t) => `${(t.celsius >= 80 ? red : (x) => x)(`${t.celsius}°C`)} ${dim(t.label)}`).join('  ') : dim('no sensors')} ${ICON[s.temps.status]}`);

    const right = [section('Network', rw)];
    const nW = Math.max(8, rw - 22);
    right.push(` ${cyan('↓ in ')} ${bytes(s.network.rxRate).padStart(6)}/s ${cyan(spark(hist.map((h) => h.rx), nW))}`);
    right.push(` ${yellow('↑ out')} ${bytes(s.network.txRate).padStart(6)}/s ${yellow(spark(hist.map((h) => h.tx), nW))}`);
    right.push(dim(fit(`  ${'INTERFACE'.padEnd(16)} ${'IN/s'.padStart(8)} ${'OUT/s'.padStart(8)} ${'TOTAL IN'.padStart(9)} ${'TOTAL OUT'.padStart(9)}`, rw)));
    for (const i of s.network.interfaces) {
      right.push(`  ${fit(i.name, 16)} ${bytes(i.rxRate).padStart(8)} ${bytes(i.txRate).padStart(8)} ${bytes(i.rxTotal).padStart(9)} ${bytes(i.txTotal).padStart(9)}`);
    }

    const rows = [];
    if (two) {
      const n = Math.max(left.length, right.length);
      for (let i = 0; i < n; i++) rows.push(fit(left[i] ?? '', lw) + dim('│') + (right[i] ?? ''));
    } else rows.push(...left, ...right);

    rows.push(section('Storage & mounts', W));
    const dW = Math.max(8, Math.min(40, W - 80));
    rows.push(dim(fit(`   ${'MOUNT'.padEnd(22)} ${'DEVICE'.padEnd(14)} ${'TYPE'.padEnd(6)} ${'USAGE'.padEnd(dW)}  ${'USE%'.padStart(5)} ${'USED'.padStart(7)} ${'FREE'.padStart(7)} ${'SIZE'.padStart(7)}`, W)));
    for (const d of s.disks?.list || []) {
      rows.push(d.missing
        ? ` ${ICON.crit} ${fit(d.mount, 22)} ${red('NOT MOUNTED (expected)')}`
        : ` ${ICON[d.status]} ${fit(d.mount, 22)} ${dim(fit(d.device, 14))} ${fit(d.type, 6)} ${bar(d.percent, dW, d.status)}  ${pctColor(d.percent)(d.percent.toFixed(1).padStart(5))} ${bytes(d.used).padStart(7)} ${bytes(d.free).padStart(7)} ${bytes(d.total).padStart(7)}`);
    }
    return rows;
  }


  // cols: [{ key, label, w (0 = rest of the line), right, get (sort value, omit = not sortable), fmt }]
  function makeTable(name, cols, items, W, { pinned = () => false, prefix = () => ' ' } = {}) {
    const st = sorts[name];
    const col = cols.find((c) => c.key === st.key && c.get) || cols.find((c) => c.get);
    const cmp = (a, b) => (typeof a === 'string' || typeof b === 'string' ? String(a ?? '').localeCompare(String(b ?? '')) : (a ?? -1) - (b ?? -1));
    const sorted = [...items].sort((a, b) => (pinned(b) - pinned(a)) || cmp(col.get(a), col.get(b)) * st.dir);
    let x = 4;
    let head = '   ';
    const hits = [];
    const widths = cols.map((c) => c.w || Math.max(8, W - x - cols.reduce((n, k) => n + (k.w ? k.w + 1 : 0), 0)));
    cols.forEach((c, i) => {
      const arrow = c.key === col.key ? (st.dir > 0 ? '↑' : '↓') : '';
      const label = c.label + arrow;
      const cell = c.right ? label.padStart(widths[i]) : label.padEnd(widths[i]);
      head += (c.key === col.key ? bold(cell) : c.get ? cell : dim(cell)) + ' ';
      if (c.get) hits.push({ x0: x, x1: x + widths[i] - 1, key: c.key });
      x += widths[i] + 1;
    });
    const line = (it) => (pinned(it) ? PIN : ' ') + prefix(it) + ' ' + cols.map((c, i) => {
      const v = String(c.fmt(it) ?? '');
      return c.right ? ' '.repeat(Math.max(0, widths[i] - vlen(v))) + fit(v, Math.min(widths[i], vlen(v))) : fit(v, widths[i]);
    }).join(' ');
    return { header: head, hits, sorted, line };
  }
  const cycleSort = (name, cols, reverse) => {
    const st = sorts[name];
    if (reverse) st.dir = -st.dir;
    else { const keys = cols.filter((c) => c.get).map((c) => c.key); st.key = keys[(keys.indexOf(st.key) + 1) % keys.length]; st.dir = ASC_FIRST.has(st.key) ? 1 : -1; }
    message = dim(` sorted by ${st.key} ${st.dir > 0 ? '↑' : '↓'}`);
  };
  let tableCols = {};

  function ports(s, W) {
    const sv = s.services;
    const order = new Map((cfg.pinned || []).map((k, i) => [k, i]));
    const list = sv.ports.filter((p) => showEphemeral || !p.ephemeral || p.pinned || !p.listening);
    const listening = sv.ports.filter((p) => p.listening).length;
    const cols = tableCols.Ports = [
      { key: 'port', label: 'PORT', w: 10, right: true, get: (p) => p.port, fmt: (p) => `${p.port}/${p.proto}` },
      { key: 'name', label: 'NAME / ALIAS', w: 24, get: (p) => (p.alias || p.name || '').toLowerCase(), fmt: (p) => (p.alias ? bold(p.alias) : (p.name || dim('—')) + (p.guessed ? dim('?') : '')) },
      { key: 'process', label: 'PROCESS', w: 14, get: (p) => p.owner?.comm || '', fmt: (p) => p.owner?.comm || dim('—') },
      { key: 'pid', label: 'PID', w: 7, right: true, get: (p) => p.owner?.pid ?? null, fmt: (p) => p.owner?.pid || '' },
      { key: 'unit', label: 'UNIT', w: 22, get: (p) => p.owner?.unit || '', fmt: (p) => dim(p.owner?.unit || '') },
      { key: 'target', label: 'TARGET', w: 18, fmt: (p) => (p.owner?.container ? `→ ${p.owner.container}` : '') },
      { key: 'bind', label: 'BIND', w: 0, get: (p) => p.addresses.join(','), fmt: (p) => (p.listening ? dim(p.addresses.join(', ')) : red('stopped listening')) },
    ];
    const t = makeTable('Ports', cols, list, W, {
      pinned: (p) => (order.has(p.key) ? 1 : 0),
      prefix: (p) => (p.listening ? ICON[p.status] : red('×')),
    });
    const fixed = [section('Listening ports', W, ` ${listening} listening · ${sv.ports.length - listening} stopped · ${showEphemeral ? 'ephemeral shown' : 'ephemeral hidden'} · checked ${clock(sv.checkedAt)} `), t.header];
    const rows = t.sorted.map(t.line);
    if (!list.some((p) => p.owner && p.owner.pid)) rows.push('', dim('  process owners of other users are visible to the installed service (or run as root)'));
    return { fixed, rows, hits: t.hits, headerIndex: 1 };
  }

  function services(s, W) {
    const sv = s.services;
    const units = s.units || {};
    const pinnedUnits = (sv.pinned || []).filter((p) => p.kind === 'unit');
    const pinOrder = new Map(pinnedUnits.map((p, i) => [p.target, i]));
    const items = [];
    for (const p of pinnedUnits) items.push({ name: p.target, alias: p.alias, state: p.state, status: p.status, description: p.detail, kind: 'service' });
    for (const f of sv.failed) if (!pinOrder.has(f.name)) items.push({ name: f.name, alias: f.alias, state: 'failed', status: 'crit', description: f.description, kind: 'service' });
    for (const r of sv.running) if (!pinOrder.has(r.name)) items.push({ name: r.name, alias: r.alias, state: 'running', status: 'ok', description: r.description, kind: r.kind });
    for (const it of items) { const u = units[it.name]; it.cpu = u ? u[0] : null; it.mem = u ? u[1] : null; }
    const totalCpu = Object.values(units).reduce((n, u) => n + u[0], 0);
    const cols = tableCols.Services = [
      { key: 'name', label: 'NAME / ALIAS', w: 24, get: (i) => (i.alias || i.name).toLowerCase(), fmt: (i) => (i.alias ? bold(i.alias) : i.name) },
      { key: 'cpu', label: 'CPU%', w: 6, right: true, get: (i) => i.cpu, fmt: (i) => (i.cpu == null ? dim('—') : pctColor(i.cpu)(i.cpu.toFixed(1))) },
      { key: 'mem', label: 'MEMORY', w: 8, right: true, get: (i) => i.mem, fmt: (i) => (i.mem == null ? dim('—') : bytes(i.mem)) },
      { key: 'unit', label: 'UNIT', w: 28, get: (i) => i.name, fmt: (i) => dim(i.kind === 'container' ? `${i.name} (container)` : i.name) },
      { key: 'state', label: 'STATE', w: 12, get: (i) => i.state, fmt: (i) => (i.status === 'ok' ? green(i.state) : i.status === 'warn' ? yellow(i.state) : red(i.state)) },
      { key: 'description', label: 'DESCRIPTION', w: 0, get: (i) => i.description || '', fmt: (i) => dim(i.description || '') },
    ];
    const t = makeTable('Services', cols, items, W, {
      pinned: (i) => (pinOrder.has(i.name) ? 1 : 0),
      prefix: (i) => ICON[i.status],
    });
    const fixed = [section('Services', W, ` ${sv.running.length} running · ${sv.failed.length} failed · ${totalCpu.toFixed(1)}% CPU in services · checked ${clock(sv.checkedAt)} `), t.header];
    return { fixed, rows: t.sorted.map(t.line), hits: t.hits, headerIndex: 1 };
  }

  function alerts(s, W) {
    const list = currentIssues(s);
    const rows = [section('Now', W, list.length ? ` ${list.length} issue(s) ` : ' all clear ')];
    if (!list.length) rows.push(` ${green('✓')} nothing needs attention`);
    for (const i of list) rows.push(` ${ICON[i.level]} ${fit((i.level === 'crit' ? red : yellow)(i.level === 'crit' ? 'ERROR' : 'WARN'), 6)} ${dim(fit(i.area, 14))} ${i.text}`);
    rows.push('', section('History', W, ` status changes ${src.kind === 'daemon' ? 'since the daemon started' : 'since sht opened'} `));
    if (!src.alerts.length) rows.push(dim('  no status changes yet'));
    for (const a of [...src.alerts].reverse()) {
      rows.push(` ${dim(new Date(a.t).toLocaleString())}  ${ICON[a.to]} ${fit(a.check, 12)} ${COLOR[a.from](a.from)} → ${COLOR[a.to](a.to)}`);
    }
    return { rows };
  }

  function processes(s, W) {
    const portsByPid = new Map();
    for (const p of s.services?.ports || []) {
      if (p.listening && p.owner?.pid) {
        const arr = portsByPid.get(p.owner.pid) || [];
        arr.push(p.proto === 'tcp' ? String(p.port) : `${p.port}/${p.proto}`);
        portsByPid.set(p.owner.pid, arr);
      }
    }
    const pinnedProcs = new Set((cfg.pinned || []).filter((k) => k.startsWith('proc:')).map((k) => k.slice(5)));
    const aliasFor = (r) => C.aliasOf(cfg, `proc:${r.comm}`, r.unit && `unit:${r.unit}`, ...(portsByPid.get(r.pid) || []).map((p) => (p.includes('/') ? `${p.split('/')[1]}/${p.split('/')[0]}` : `tcp/${p}`)));
    const cols = tableCols.Processes = [
      { key: 'pid', label: 'PID', w: 7, right: true, get: (r) => r.pid, fmt: (r) => r.pid },
      { key: 'user', label: 'USER', w: 9, fmt: (r) => r.user || '' },
      { key: 'cpu', label: 'CPU%', w: 5, right: true, get: (r) => r.cpu, fmt: (r) => pctColor(r.cpu)(r.cpu.toFixed(1)) },
      { key: 'mem', label: 'MEM%', w: 5, right: true, get: (r) => r.rss, fmt: (r) => r.mem.toFixed(1) },
      { key: 'rss', label: 'RSS', w: 6, right: true, get: (r) => r.rss, fmt: (r) => bytes(r.rss) },
      { key: 'name', label: 'NAME / ALIAS', w: 22, get: (r) => (aliasFor(r) || r.comm).toLowerCase(), fmt: (r) => { const a = aliasFor(r); return a ? bold(a) : r.comm; } },
      { key: 'unit', label: 'UNIT', w: 22, fmt: (r) => dim(r.unit || '') },
      { key: 'ports', label: 'PORTS', w: 11, fmt: (r) => cyan((portsByPid.get(r.pid) || []).join(',')) },
      { key: 'cmd', label: 'COMMAND', w: 0, fmt: (r) => dim(r.cmd || '') },
    ];
    const t = makeTable('Processes', cols, procRows, W, { pinned: (r) => (pinnedProcs.has(r.comm) ? 1 : 0) });
    const fixed = [section('Processes', W, ` ${procs.count || 0} total `), t.header];
    const rows = t.sorted.map((r) => ({ proc: r, render: () => t.line(r) }));
    if (!rows.length) rows.push(dim('  sampling…'));
    return { fixed, rows, hits: t.hits, headerIndex: 1 };
  }

  // ----- commands -----
  async function exec(line) {
    const tokens = tokenize(line.trim().replace(/^\//, ''));
    if (!tokens.length) return;
    const cmd = tokens[0];
    if (['quit', 'exit', 'q'].includes(cmd)) return quit();
    if (cmd === 'sort') {
      const name = TABS[tab];
      const cols = (tableCols[name] || []).filter((c) => c.get);
      const k = tokens[1];
      if (!sorts[name]) { message = red(' /sort works on the Ports, Services and Processes tabs'); return; }
      if (!cols.some((c) => c.key === k)) { message = red(` usage: /sort ${cols.map((c) => c.key).join('|')} [asc|desc]`); return; }
      sorts[name] = { key: k, dir: tokens[2] === 'asc' ? 1 : tokens[2] === 'desc' ? -1 : sorts[name].key === k ? -sorts[name].dir : sorts[name].dir };
      message = green(` ✓ sorted by ${k} ${sorts[name].dir > 0 ? '↑' : '↓'}`); return;
    }
    if (cmd === 'tab') { const n = Number(tokens[1]); if (n >= 1 && n <= TABS.length) setTab(n - 1); return; }
    if (cmd === 'watch') { message = dim(' this screen is already live'); return; }
    const goto = { status: 0, ports: 1, services: 2, pinned: 1 }[cmd];
    if (goto !== undefined && tokens.length === 1) { setTab(goto); return; }
    busy = true;
    message = dim(` running /${tokens.join(' ')} …`); render();
    capture = [];
    const ctx = {
      interactive: true, tui: true, baseOpts,
      suspend: () => { suspended = true; const c = capture; capture = null; leave(); if (c?.length) origLog(c.join('\n')); },
      resume: () => {
        spawnSync('bash', ['-c', 'read -r -p "── press Enter to return to sht ── " _'], { stdio: 'inherit' });
        suspended = false; capture = []; enter(); out.write(`${E}2J`);
      },
    };
    try { await run(tokens, ctx); } catch (e) { (capture || []).push(red(e.message)); }
    const lines = (capture || []).filter((l, i, a) => l !== '' || i < a.length - 1);
    capture = null;
    busy = false;
    if (lines.length > 3) { pager = { title: `/${tokens.join(' ')}`, lines, offset: 0 }; message = dim(` /${cmd} done`); }
    else message = lines.length ? ` ${lines.join(dim(' · '))}` : dim(` /${cmd} done`);
    try {
      const next = C.loadConfig(baseOpts.config);
      if (JSON.stringify(next) !== JSON.stringify(cfg)) {
        const rebind = next.host !== cfg.host || next.port !== cfg.port;
        cfg = next;
        if (src.kind === 'local') src.reconfigure(cfg);
        if (rebind && src.kind === 'daemon') { src.stop(); setTimeout(async () => { src = await openSource(cfg, { onUpdate }); }, 1500); }
      }
    } catch { /* ignore */ }
    svc = serviceState();
  }

  // ----- input: raw bytes → keys / mouse -----
  const KEYS = [
    [/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/, (m) => ({ mouse: { b: Number(m[1]), x: Number(m[2]), y: Number(m[3]), down: m[4] === 'M' } })],
    [/^\x1b\[A|^\x1bOA/, () => ({ name: 'up' })], [/^\x1b\[B|^\x1bOB/, () => ({ name: 'down' })],
    [/^\x1b\[C|^\x1bOC/, () => ({ name: 'right' })], [/^\x1b\[D|^\x1bOD/, () => ({ name: 'left' })],
    [/^\x1b\[5~/, () => ({ name: 'pageup' })], [/^\x1b\[6~/, () => ({ name: 'pagedown' })],
    [/^\x1b\[H|^\x1b\[1~|^\x1bOH/, () => ({ name: 'home' })], [/^\x1b\[F|^\x1b\[4~|^\x1bOF/, () => ({ name: 'end' })],
    [/^\x1b\[Z/, () => ({ name: 'backtab' })], [/^\x1b\[[0-9;]*[~A-Za-z]/, () => ({ name: 'unknown' })],
    [/^\x1b/, () => ({ name: 'escape' })], [/^\r|^\n/, () => ({ name: 'enter' })], [/^\t/, () => ({ name: 'tab' })],
    [/^[\x7f\b]/, () => ({ name: 'backspace' })], [/^\x03/, () => ({ name: 'ctrl-c' })], [/^\x0c/, () => ({ name: 'ctrl-l' })],
    [/^\x15/, () => ({ name: 'ctrl-u' })], [/^[\x00-\x1f]/, () => ({ name: 'unknown' })],
  ];
  function* parseKeys(str) {
    let s = str;
    while (s.length) {
      let matched = false;
      for (const [re, fn] of KEYS) {
        const m = re.exec(s);
        if (m) { yield fn(m); s = s.slice(m[0].length); matched = true; break; }
      }
      if (!matched) { const ch = String.fromCodePoint(s.codePointAt(0)); yield { ch }; s = s.slice(ch.length); }
    }
  }

  async function onKey(k) {
    const H = out.rows || 24;
    const page = Math.max(1, H - 6);
    if (k.name === 'ctrl-c') return quit();
    if (k.name === 'ctrl-l') { out.write(`${E}2J`); return render(); }
    if (k.mouse) {
      const { b, x, y, down } = k.mouse;
      if (b === 64 || b === 65) { // wheel
        if (pager) pager.offset += b === 64 ? -3 : 3; else scroll[tab] += b === 64 ? -3 : 3;
        return render();
      }
      if (down && b === 0 && y === 1 && !pager) { const h = hits.find((r) => x >= r.x0 && x <= r.x1); if (h) setTab(h.tab); }
      else if (down && b === 0 && !pager && headerHits && y === headerHits.y) {
        const h = headerHits.hits.find((r) => x >= r.x0 && x <= r.x1);
        if (h) {
          const name = TABS[tab]; const st = sorts[name];
          if (st.key === h.key) st.dir = -st.dir;
          else { st.key = h.key; st.dir = ASC_FIRST.has(h.key) ? 1 : -1; }
          message = dim(` sorted by ${st.key} ${st.dir > 0 ? '↑' : '↓'}`);
          render();
        }
      }
      return;
    }
    if (pager) {
      if (['escape', 'enter'].includes(k.name) || k.ch === 'q') pager = null;
      else if (k.name === 'up') pager.offset--;
      else if (k.name === 'down') pager.offset++;
      else if (k.name === 'pageup') pager.offset -= page;
      else if (k.name === 'pagedown' || k.ch === ' ') pager.offset += page;
      else if (k.name === 'home') pager.offset = 0;
      else if (k.name === 'end') pager.offset = 1e9;
      return render();
    }
    if (busy) return;
    if (cmdMode) {
      if (k.name === 'enter') {
        const line = input; input = ''; cmdMode = false; histIdx = -1;
        if (line.replace(/^\//, '').trim()) { history.unshift(line); history.length = Math.min(history.length, 100); await exec(line); }
      } else if (k.name === 'escape') { input = ''; cmdMode = false; }
      else if (k.name === 'backspace') { input = input.slice(0, -1); if (!input) cmdMode = false; }
      else if (k.name === 'ctrl-u') input = '/';
      else if (k.name === 'up') { if (history.length) { histIdx = Math.min(history.length - 1, histIdx + 1); input = history[histIdx]; } }
      else if (k.name === 'down') { histIdx = Math.max(-1, histIdx - 1); input = histIdx >= 0 ? history[histIdx] : '/'; }
      else if (k.name === 'tab') {
        const word = input.replace(/^\//, '');
        if (!word.includes(' ')) {
          const names = [...Object.keys(COMMANDS), 'sort', 'tab', 'quit'].filter((n) => n.startsWith(word));
          if (names.length === 1) input = `/${names[0]} `;
          else if (names.length) message = dim(` ${names.map((n) => `/${n}`).join('  ')}`);
        }
      } else if (k.ch && k.ch >= ' ') input += k.ch;
      return render();
    }
    // navigation mode
    message = '';
    if (k.ch === '/' || k.ch === ':') { cmdMode = true; input = '/'; }
    else if (k.ch >= '1' && k.ch <= String(TABS.length)) return setTab(Number(k.ch) - 1);
    else if (k.name === 'right' || k.name === 'tab') return setTab(tab + 1);
    else if (k.name === 'left' || k.name === 'backtab') return setTab(tab - 1);
    else if (k.ch === 'a' || k.ch === '!') return setTab(3);
    else if (k.ch === 'q') return quit();
    else if (k.ch === '?') pager = { title: 'help', lines: helpText(true).split('\n'), offset: 0 };
    else if (k.ch === 'e') { showEphemeral = !showEphemeral; message = dim(` ephemeral ports ${showEphemeral ? 'shown' : 'hidden'}`); }
    else if ((k.ch === 's' || k.ch === 'r') && sorts[TABS[tab]]) cycleSort(TABS[tab], tableCols[TABS[tab]] || [], k.ch === 'r');
    else if (k.name === 'up') scroll[tab]--;
    else if (k.name === 'down') scroll[tab]++;
    else if (k.name === 'pageup') scroll[tab] -= page;
    else if (k.name === 'pagedown' || k.ch === ' ') scroll[tab] += page;
    else if (k.name === 'home') scroll[tab] = 0;
    else if (k.name === 'end') scroll[tab] = 1e9;
    render();
  }

  stdin.setEncoding('utf8');
  stdin.on('data', async (chunk) => {
    if (suspended) return;
    for (const k of parseKeys(chunk)) await onKey(k);
  });
  out.on('resize', () => { out.write(`${E}2J`); render(); });
  process.on('exit', () => { clearInterval(procTimer); clearInterval(svcTimer); clearTimeout(clockTimer); });

  enter();
  out.write(`${E}2J`);
  render();
  tick();
}

module.exports = { tui };
