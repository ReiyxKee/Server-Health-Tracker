'use strict';
// Config: defaults (config.default.json) merged with one user file.
// Read order: --config FILE > $SHT_CONFIG > /etc/sht/config.json > ~/.config/sht/config.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_FILE = path.join(__dirname, '..', 'config.default.json');
const SYSTEM_FILE = '/etc/sht/config.json';
const USER_FILE = path.join(os.homedir(), '.config', 'sht', 'config.json');
const UNIT_FILE = '/etc/systemd/system/sht.service';

const isInstalled = () => fs.existsSync(UNIT_FILE) || fs.existsSync(SYSTEM_FILE);

function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SHT_CONFIG) return path.resolve(process.env.SHT_CONFIG);
  if (fs.existsSync(SYSTEM_FILE)) return SYSTEM_FILE;
  if (fs.existsSync(USER_FILE)) return USER_FILE;
  return null;
}

// Where `sht port/alias/pin/...` write to.
function writeTarget(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SHT_CONFIG) return path.resolve(process.env.SHT_CONFIG);
  return isInstalled() ? SYSTEM_FILE : USER_FILE;
}

function canWrite(file) {
  try { fs.accessSync(fs.existsSync(file) ? file : nearestDir(file), fs.constants.W_OK); return true; } catch { return false; }
}
function nearestDir(file) {
  let d = path.dirname(file);
  while (!fs.existsSync(d)) d = path.dirname(d);
  return d;
}

function readRaw(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Atomic write that keeps the file's owner and mode (root editing a file the service owns).
function saveRaw(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let st = null;
  try { st = fs.statSync(file); } catch { /* new file */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.chmodSync(tmp, st ? st.mode & 0o777 : 0o644);
  if (st && process.getuid() === 0) { try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* ignore */ } }
  fs.renameSync(tmp, file);
}

// One edit from the web or CLI. change: { action: pin|unpin|alias|unalias, key, alias? }
const KEY_RE = /^(?:(?:tcp|udp)\/\d{1,5}|(?:unit|proc):[\w@.:+-]{1,200})$/;
function applyEdit(raw, { action, key, alias }) {
  if (!KEY_RE.test(String(key || ''))) throw new Error(`invalid target "${key}"`);
  raw.aliases = { ...(raw.aliases || {}) };
  raw.pinned = [...(raw.pinned || [])];
  const name = typeof alias === 'string' ? alias.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64) : '';
  switch (action) {
    case 'pin': if (!raw.pinned.includes(key)) raw.pinned.push(key); if (name) raw.aliases[key] = name; break;
    case 'unpin': raw.pinned = raw.pinned.filter((k) => k !== key); break;
    case 'alias': if (name) raw.aliases[key] = name; else delete raw.aliases[key]; break;
    case 'unalias': delete raw.aliases[key]; break;
    default: throw new Error(`unknown action "${action}"`);
  }
  return raw;
}

// Legacy keys (services / ports[]) become pinned + aliases.
function normalize(user) {
  const u = { ...user };
  u.aliases = { ...(u.aliases || {}) };
  u.pinned = [...(u.pinned || [])];
  for (const s of u.services || []) { const k = `unit:${s.replace(/\.service$/, '')}`; if (!u.pinned.includes(k)) u.pinned.push(k); }
  for (const p of u.ports || []) {
    const k = `${p.proto || 'tcp'}/${p.port}`;
    if (p.name && !u.aliases[k]) u.aliases[k] = p.name;
    if (p.expected && !u.pinned.includes(k)) u.pinned.push(k);
  }
  delete u.services; delete u.ports;
  return u;
}

function loadConfig(explicit) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
  const file = resolveConfigPath(explicit);
  const user = normalize(readRaw(file));
  const cfg = { ...defaults, ...user, thresholds: { ...defaults.thresholds, ...(user.thresholds || {}) } };
  if (process.env.SHT_HOST) cfg.host = process.env.SHT_HOST;
  if (process.env.SHT_PORT) cfg.port = Number(process.env.SHT_PORT);
  cfg.file = file;
  return cfg;
}

// ---------- targets: what an alias / pin refers to ----------
// tcp/7001  udp/6969  unit:nginx  proc:docker-proxy
function parseTarget(str) {
  const s = String(str).trim();
  let m;
  if ((m = s.match(/^(?:(tcp|udp)[/:])?(\d{1,5})(?:\/(tcp|udp))?$/i))) return `${(m[1] || m[3] || 'tcp').toLowerCase()}/${Number(m[2])}`;
  if ((m = s.match(/^unit:(.+)$/))) return `unit:${m[1].replace(/\.service$/, '')}`;
  if ((m = s.match(/^proc:(.+)$/))) return `proc:${m[1]}`;
  // bare name: a systemd unit if one exists, else a process name
  const name = s.replace(/\.service$/, '');
  try {
    const load = execFileSync('systemctl', ['show', '-p', 'LoadState', '--value', `${name}.service`], { encoding: 'utf8', timeout: 3000 }).trim();
    if (load === 'loaded') return `unit:${name}`;
  } catch { /* no systemd */ }
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === name) return `proc:${name}`; } catch { /* gone */ }
  }
  return null;
}

function describeTarget(key) {
  if (key.startsWith('unit:')) return { kind: 'unit', target: key.slice(5) };
  if (key.startsWith('proc:')) return { kind: 'proc', target: key.slice(5) };
  const [proto, port] = key.split('/');
  return { kind: 'port', target: `${port}/${proto}`, proto, port: Number(port) };
}

const aliasOf = (cfg, ...keys) => { for (const k of keys) if (k && cfg.aliases?.[k]) return cfg.aliases[k]; return null; };
const isLocalHost = (h) => h === 'localhost' || h === '::1' || String(h).startsWith('127.');

module.exports = {
  applyEdit, KEY_RE,
  loadConfig, readRaw, saveRaw, normalize, writeTarget, canWrite, resolveConfigPath, isInstalled,
  parseTarget, describeTarget, aliasOf, isLocalHost, DEFAULT_FILE, SYSTEM_FILE, USER_FILE, UNIT_FILE,
};
