'use strict';
// Every sht command, shared by `sht <cmd> ...` and the interactive `/cmd` prompt.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const C = require('./config');
const T = require('./term');

const SCRIPT = path.join(__dirname, '..', 'bin', 'sht.js');
const pkg = require('../package.json');

// ---------- args ----------
const VALUE_FLAGS = new Set(['config', 'host', 'port', 'allow-from']);
function parseArgs(argv) {
  const opts = { _: [], 'allow-from': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f') opts.follow = true;
    else if (a === '-h') opts.help = true;
    else if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (v === undefined && VALUE_FLAGS.has(k)) v = argv[++i];
      if (k === 'allow-from') opts[k].push(...String(v).split(',').filter(Boolean));
      else opts[k] = v === undefined ? true : v;
    } else opts._.push(a);
  }
  return opts;
}

// ---------- helpers ----------
function serviceState() {
  if (!fs.existsSync(C.UNIT_FILE)) return 'not installed';
  try { return execFileSync('systemctl', ['is-active', 'sht.service'], { encoding: 'utf8' }).trim(); }
  catch (e) { return String(e.stdout || 'inactive').trim(); }
}

// Re-run this command as root through sudo. Returns true if it was delegated.
function asRoot(ctx, argv) {
  if (process.getuid() === 0) return false;
  const cfgArg = ctx.opts.config ? ['--config', path.resolve(ctx.opts.config)] : [];
  console.log(T.dim(`→ needs root, running: sudo sht ${argv.join(' ')}`));
  const r = inherit(ctx, 'sudo', [process.execPath, SCRIPT, ...cfgArg, ...argv]);
  if (r.status && !ctx.interactive) process.exitCode = r.status;
  return true;
}

// Run a child on the real terminal (sudo password prompt, journalctl, …).
function inherit(ctx, cmd, args) {
  if (ctx.suspend) ctx.suspend();
  const raw = !ctx.suspend && ctx.interactive && process.stdin.isTTY && process.stdin.isRaw;
  if (raw) process.stdin.setRawMode(false);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (raw) process.stdin.setRawMode(true);
  if (ctx.resume) ctx.resume();
  return r;
}

function cfgOf(ctx) {
  const cfg = C.loadConfig(ctx.opts.config);
  if (ctx.opts.host && ctx.cmd !== 'host') cfg.host = ctx.opts.host;
  if (ctx.opts.port && ctx.cmd !== 'port') cfg.port = Number(ctx.opts.port);
  return cfg;
}

function getJson(cfg, p, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    const req = http.get({ host, port: cfg.port, path: p, timeout }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function collectLocal(cfg) {
  const { Collector } = require('./collector');
  const c = new Collector(cfg);
  c.viewers = 1;
  c.prevCpu = await c.cpuSample();
  await c.network();
  await c.tickServices();
  await c.unitUsage();
  await Promise.all([c.tickDisks(), c.tickServices(), new Promise((r) => setTimeout(r, 500))]);
  await c.tickFast();
  return c.state;
}

async function snapshot(cfg, opts = {}) {
  if (!opts.local) {
    try { return { state: await getJson(cfg, '/api/health'), source: 'daemon' }; } catch { /* fall back */ }
  }
  return { state: await collectLocal(cfg), source: 'local' };
}

// Edit the writable config file (sudo if needed). mutate(raw) returns a message.
function editConfig(ctx, mutate) {
  const file = C.writeTarget(ctx.opts.config);
  if (!C.canWrite(file)) { asRoot(ctx, ctx.argv); return null; }
  const raw = C.normalize(C.readRaw(file));
  const msg = mutate(raw);
  if (msg === false) return null;
  C.saveRaw(file, raw);
  console.log(msg);
  const st = serviceState();
  const live = st === 'active' && file === C.SYSTEM_FILE;
  console.log(T.dim(`saved ${file}${live ? ' · daemon reloads it automatically' : ''}`));
  return { file, raw };
}

function needTarget(str) {
  const key = str && C.parseTarget(str);
  if (!key) {
    console.log(T.red(`unknown target "${str ?? ''}"`) + T.dim(' — use a port (7001, 6969/udp), unit:<name>, or proc:<name>'));
  }
  return key;
}

function table(head, rows) {
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c) + ' '.repeat(w[i] - strip(c).length)).join('  ').trimEnd();
  console.log(T.dim(line(head)));
  rows.forEach((r) => console.log(line(r)));
}

const SETTABLE = {
  host: 'string', port: 'port', web: 'bool', serviceUsage: 'bool', serviceUsageMs: 'ms', sampleMs: 'ms', diskMs: 'ms', serviceMs: 'ms', historyPoints: 'int',
  ignorePorts: 'list', expectedMounts: 'list',
  'thresholds.cpu': 'pair', 'thresholds.memory': 'pair', 'thresholds.swap': 'pair', 'thresholds.disk': 'pair',
  'thresholds.temp': 'pair', 'thresholds.load': 'pair',
};
function coerce(type, vals) {
  const v = vals.join(' ');
  switch (type) {
    case 'port': { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port must be 1-65535'); return n; }
    case 'bool': if (/^(on|true|yes|1)$/i.test(v)) return true; if (/^(off|false|no|0)$/i.test(v)) return false; throw new Error('use on/off');
    case 'ms': { const n = Number(v); if (!(n >= 500)) throw new Error('must be ≥ 500 (milliseconds)'); return n; }
    case 'int': { const n = Number(v); if (!Number.isInteger(n) || n < 10) throw new Error('must be an integer ≥ 10'); return n; }
    case 'list': return v.split(/[\s,]+/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    case 'pair': { const p = v.split(/[\s,]+/).map(Number); if (p.length !== 2 || p.some(isNaN) || p[0] > p[1]) throw new Error('give "warn,crit", e.g. 80,95'); return p; }
    default: if (!v) throw new Error('value required'); return v;
  }
}
function setPath(obj, key, val) {
  const parts = key.split('.');
  let o = obj;
  while (parts.length > 1) { const k = parts.shift(); o[k] = { ...(o[k] || {}) }; o = o[k]; }
  if (val === undefined) delete o[parts[0]]; else o[parts[0]] = val;
}

async function afterBindChange(ctx, file) {
  if (process.getuid() !== 0 || file !== C.SYSTEM_FILE) return;
  const firewall = require('./firewall');
  await firewall.ensure(C.loadConfig(file), { allowFrom: ctx.opts['allow-from'], noFirewall: ctx.opts['no-firewall'] });
}

// ---------- command table ----------
const COMMANDS = {
  status: { help: 'health summary  [--no-ephemeral] [--json] [--local]', run: async (ctx) => {
    const cfg = cfgOf(ctx);
    const { state, source } = await snapshot(cfg, ctx.opts);
    if (ctx.opts.json) return console.log(JSON.stringify(state, null, 2));
    console.log(T.renderStatus(state, ctx.opts));
    console.log(T.dim(`source: ${source === 'daemon' ? `daemon http://${cfg.host}:${cfg.port}` : 'local collection (daemon not running)'}`));
    if (!ctx.interactive) process.exitCode = { ok: 0, warn: 1, crit: 2 }[state.status];
  } },
  watch: { help: 'live view (Ctrl+C, or Enter inside the prompt, to stop)', run: (ctx) => require('./watch').watch(cfgOf(ctx), ctx) },
  pinned: { help: 'pinned  pinned items and their state', run: async (ctx) => {
    const { state } = await snapshot(cfgOf(ctx), ctx.opts);
    if (ctx.opts.json) return console.log(JSON.stringify(state.services.pinned, null, 2));
    console.log(T.renderPinned(state.services.pinned) || T.dim('nothing pinned yet — try: /pin 7001 Jellyfin'));
  } },
  ports: { help: 'listening ports with process, unit and alias  [--no-ephemeral] [--json]', run: async (ctx) => {
    const { state } = await snapshot(cfgOf(ctx), ctx.opts);
    const list = state.services.ports.filter((p) => !ctx.opts['no-ephemeral'] || !p.ephemeral || !p.listening || p.pinned);
    if (ctx.opts.json) return console.log(JSON.stringify(list, null, 2));
    table(['', 'PORT', 'NAME', 'PROCESS', 'UNIT', 'TARGET', 'BIND'], list.map((p) => [
      `${p.pinned ? '📌' : '  '}${p.listening ? T.green('●') : T.red('○')}`,
      `${p.port}/${p.proto}`, p.alias ? T.bold(p.alias) : (p.name || '—') + (p.guessed ? T.dim('?') : ''),
      p.owner ? `${p.owner.comm}[${p.owner.pid}]` : T.dim('—'), p.owner?.unit || '', p.owner?.container ? `→ ${p.owner.container}` : '',
      p.listening ? p.addresses.join(',') : T.red('stopped listening'),
    ]));
    if (!list.some((p) => p.owner && p.owner.unit !== 'pm2-reiyx' && p.owner.pid)) console.log(T.dim('\nprocess owners of other users need root or the installed service'));
  } },
  services: { help: 'pinned, failed and running services  [--json]', run: async (ctx) => {
    const { state } = await snapshot(cfgOf(ctx), ctx.opts);
    const sv = state.services;
    if (ctx.opts.json) return console.log(JSON.stringify(sv, null, 2));
    if (sv.failed.length) { console.log(T.bold(T.red('Failed'))); table(['UNIT', 'ALIAS', 'DESCRIPTION'], sv.failed.map((f) => [f.name, f.alias || '', f.description])); console.log(); }
    console.log(T.bold(`Running (${sv.running.length})`));
    table(['UNIT', 'ALIAS', 'DESCRIPTION'], sv.running.map((r) => [r.name, r.alias ? T.bold(r.alias) : '', T.dim(r.description)]));
  } },

  alias: { help: 'alias <target> <name…>  label a port/unit/process (no args: list)', run: (ctx) => {
    const [t, ...name] = ctx.opts._;
    if (!t) {
      const a = C.loadConfig(ctx.opts.config).aliases;
      if (!Object.keys(a).length) return console.log(T.dim('no aliases yet — try: /alias 7001 Jellyfin'));
      return table(['TARGET', 'ALIAS'], Object.entries(a).map(([k, v]) => [k, v]));
    }
    const key = needTarget(t); if (!key) return;
    if (!name.length) return console.log(T.red('give a name: /alias 7001 Jellyfin'));
    editConfig(ctx, (raw) => { raw.aliases[key] = name.join(' '); return `✓ ${key} is now "${name.join(' ')}"`; });
  } },
  unalias: { help: 'unalias <target>  remove a label', run: (ctx) => {
    const key = needTarget(ctx.opts._[0]); if (!key) return;
    editConfig(ctx, (raw) => { if (!raw.aliases[key]) { console.log(T.dim(`${key} has no alias`)); return false; } delete raw.aliases[key]; return `✓ removed alias for ${key}`; });
  } },
  pin: { help: 'pin <target> [alias…]  show on top, alert when it goes down', run: (ctx) => {
    const [t, ...name] = ctx.opts._;
    const key = needTarget(t); if (!key) return;
    editConfig(ctx, (raw) => {
      if (!raw.pinned.includes(key)) raw.pinned.push(key);
      if (name.length) raw.aliases[key] = name.join(' ');
      return `📌 pinned ${key}${raw.aliases[key] ? ` (${raw.aliases[key]})` : ''}`;
    });
  } },
  unpin: { help: 'unpin <target>  stop pinning', run: (ctx) => {
    const key = needTarget(ctx.opts._[0]); if (!key) return;
    editConfig(ctx, (raw) => { const n = raw.pinned.length; raw.pinned = raw.pinned.filter((k) => k !== key); return n === raw.pinned.length ? T.dim(`${key} was not pinned`) : `✓ unpinned ${key}`; });
  } },

  web: { help: 'web on|off  serve the HTML dashboard', run: (ctx) => {
    const v = ctx.opts._[0];
    if (!v) { const c = C.loadConfig(ctx.opts.config); return console.log(`web dashboard: ${c.web === false ? 'off' : `on · http://${c.host}:${c.port}`}`); }
    let on; try { on = coerce('bool', [v]); } catch (e) { return console.log(T.red(e.message)); }
    editConfig(ctx, (raw) => { raw.web = on; return `✓ web dashboard ${on ? 'on' : 'off (API stays available for the CLI)'}`; });
  } },
  port: { help: 'port <n>  dashboard/API port (offers a firewall rule)', run: async (ctx) => {
    const v = ctx.opts._[0];
    if (!v) return console.log(`port: ${C.loadConfig(ctx.opts.config).port}`);
    let n; try { n = coerce('port', [v]); } catch (e) { return console.log(T.red(e.message)); }
    const r = editConfig(ctx, (raw) => { raw.port = n; return `✓ port ${n}`; });
    if (r) await afterBindChange(ctx, r.file);
  } },
  host: { help: 'host <addr>  bind address: 127.0.0.1, a VPN/LAN IP, or 0.0.0.0', run: async (ctx) => {
    const v = ctx.opts._[0];
    if (!v) return console.log(`host: ${C.loadConfig(ctx.opts.config).host}`);
    const r = editConfig(ctx, (raw) => { raw.host = v; return `✓ host ${v}${C.isLocalHost(v) ? ' (local only)' : ''}`; });
    if (r) await afterBindChange(ctx, r.file);
  } },
  poll: { help: 'poll <seconds>  sampling rate for CPU/memory/network', run: (ctx) => {
    const v = ctx.opts._[0];
    const c = C.loadConfig(ctx.opts.config);
    if (!v) return console.log(`poll: every ${c.sampleMs / 1000}s · disks ${c.diskMs / 1000}s · services/ports ${c.serviceMs / 1000}s`);
    const s = Number(v);
    if (!(s >= 0.5 && s <= 3600)) return console.log(T.red('give seconds between 0.5 and 3600'));
    editConfig(ctx, (raw) => { raw.sampleMs = Math.round(s * 1000); return `✓ sampling every ${s}s`; });
  } },
  set: { help: 'set <key> <value>  any setting (see keys below)', run: async (ctx) => {
    const [key, ...vals] = ctx.opts._;
    if (!SETTABLE[key]) return console.log(T.red(`unknown key "${key ?? ''}"`) + T.dim(`\nkeys: ${Object.keys(SETTABLE).join(', ')}`));
    let val; try { val = coerce(SETTABLE[key], vals); } catch (e) { return console.log(T.red(`${key}: ${e.message}`)); }
    const r = editConfig(ctx, (raw) => { setPath(raw, key, val); return `✓ ${key} = ${JSON.stringify(val)}`; });
    if (r && (key === 'host' || key === 'port')) await afterBindChange(ctx, r.file);
  } },
  unset: { help: 'unset <key>  back to the default value', run: (ctx) => {
    const key = ctx.opts._[0];
    if (!SETTABLE[key]) return console.log(T.red(`unknown key "${key ?? ''}"`));
    editConfig(ctx, (raw) => { setPath(raw, key, undefined); return `✓ ${key} reset to default`; });
  } },
  mount: { help: 'mount add|remove <path>  mounts that must be present (no args: list)', run: (ctx) => {
    const [op, p] = ctx.opts._;
    if (!op) return console.log(C.loadConfig(ctx.opts.config).expectedMounts.join('\n'));
    if (!['add', 'remove'].includes(op) || !p) return console.log(T.red('usage: mount add|remove <path>'));
    editConfig(ctx, (raw) => {
      const list = raw.expectedMounts || [...C.loadConfig(ctx.opts.config).expectedMounts];
      raw.expectedMounts = op === 'add' ? [...new Set([...list, p])] : list.filter((m) => m !== p);
      return `✓ expected mounts: ${raw.expectedMounts.join(', ')}`;
    });
  } },
  config: { help: 'show the config file in use and the merged values', run: (ctx) => {
    const cfg = C.loadConfig(ctx.opts.config);
    console.log(T.dim(`read: ${cfg.file || '(defaults only)'} · writes go to: ${C.writeTarget(ctx.opts.config)}`));
    const { file, ...rest } = cfg;
    console.log(JSON.stringify(rest, null, 2));
  } },

  install: { help: 'install [options]  daemon + web dashboard + CLI (default: everything)', run: async (ctx) => {
    if (asRoot(ctx, ctx.argv)) return;
    await require('./install').install(ctx.opts);
  } },
  uninstall: { help: 'uninstall [--purge]  remove service, /opt/sht and sht firewall rules', run: (ctx) => {
    if (asRoot(ctx, ctx.argv)) return;
    require('./install').uninstall(ctx.opts);
  } },
  start: { help: 'start the sht service', run: (ctx) => systemctl(ctx, 'start') },
  stop: { help: 'stop the sht service', run: (ctx) => systemctl(ctx, 'stop') },
  restart: { help: 'restart the sht service', run: (ctx) => systemctl(ctx, 'restart') },
  enable: { help: 'start sht at boot', run: (ctx) => systemctl(ctx, 'enable') },
  disable: { help: 'do not start sht at boot', run: (ctx) => systemctl(ctx, 'disable') },
  logs: { help: 'service log incl. detected alerts  [-f]', run: (ctx) => {
    const args = ['-u', 'sht.service', '-n', '50', '--no-pager'];
    if (ctx.opts.follow && !ctx.interactive) args.push('-f');
    inherit(ctx, 'journalctl', args);
  } },
  serve: { help: 'run the daemon in the foreground (what the service runs)', run: (ctx) => require('./daemon').serve(ctx.opts) },
  version: { help: 'print version', run: () => console.log(pkg.version) },
  help: { help: 'this list', run: (ctx) => console.log(helpText(ctx.interactive)) },
};

function systemctl(ctx, action) {
  if (!fs.existsSync(C.UNIT_FILE)) return console.log(T.yellow('sht service is not installed — run: ') + (ctx.interactive ? '/install' : 'sht install'));
  if (asRoot(ctx, [action])) return;
  inherit(ctx, 'systemctl', [action, 'sht.service']);
  if (['start', 'restart'].includes(action)) console.log(`sht.service: ${serviceState()}`);
}

const GROUPS = [
  ['Monitor', ['status', 'watch', 'pinned', 'ports', 'services']],
  ['Label & pin', ['alias', 'unalias', 'pin', 'unpin']],
  ['Settings', ['web', 'port', 'host', 'poll', 'set', 'unset', 'mount', 'config']],
  ['Service', ['install', 'uninstall', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'serve']],
];
function helpText(interactive) {
  const p = interactive ? '/' : 'sht ';
  const out = [`${T.bold('sht')} — Server Health Tracker ${pkg.version}`, ''];
  if (!interactive) out.push('Run `sht` with no arguments for the interactive prompt (slash commands).', '');
  for (const [g, names] of GROUPS) {
    out.push(T.bold(g));
    for (const n of names) {
      const h = COMMANDS[n].help;
      const i = h.indexOf('  ');
      const head = i > 0 ? h.slice(0, i) : '';
      const usage = head.startsWith(n) ? head : n;
      const desc = head.startsWith(n) ? h.slice(i + 2) : h;
      out.push(`  ${(p + usage).padEnd(34)} ${T.dim(desc)}`);
    }
    out.push('');
  }
  out.push(T.bold('Install options'));
  for (const [f, d] of [
    ['--port N', 'port for the dashboard/API (default 7002)'],
    ['--host H', 'bind address, e.g. your VPN IP (default 127.0.0.1)'],
    ['--web / --no-web', 'serve the HTML dashboard or API only (default --web)'],
    ['--allow-from CIDR', 'add a UFW rule for this source (repeatable); asked if omitted'],
    ['--no-firewall', 'never touch the firewall'],
    ['--cli-only', 'only install the sht command, no service'],
    ['--config FILE', 'install FILE as /etc/sht/config.json'],
  ]) out.push(`  ${f.padEnd(34)} ${T.dim(d)}`);
  out.push('', `${T.bold('set keys')}  ${T.dim(Object.keys(SETTABLE).join(', '))}`, '');
  out.push(T.dim('Targets: a port (7001, 6969/udp), unit:<name>, proc:<name>, or a bare unit/process name.'));
  if (interactive) out.push(T.dim('In the full-screen view: /sort cpu|mem|pid|name · PgUp/PgDn scroll processes · ↑/↓ command history · Tab completes · /quit or Ctrl+C leaves.'));
  else out.push(T.dim('Global: --config FILE (or $SHT_CONFIG). Settings needing root re-run via sudo.'));
  return out.join('\n');
}

async function run(argv, ctx = {}) {
  const opts = parseArgs(argv);
  const cmd = opts._.shift() || 'status';
  if (opts.version && cmd === 'status') return COMMANDS.version.run();
  if (opts.help) return console.log(helpText(ctx.interactive));
  const c = COMMANDS[cmd];
  if (!c) { console.log(T.red(`unknown command: ${cmd}`) + T.dim(ctx.interactive ? ' — /help' : ' — sht help')); if (!ctx.interactive) process.exitCode = 64; return; }
  return c.run({ ...ctx, cmd, opts: { ...ctx.baseOpts, ...opts, _: opts._ }, argv });
}

module.exports = { run, parseArgs, COMMANDS, snapshot, serviceState, helpText };
