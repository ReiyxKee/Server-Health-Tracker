'use strict';
// Dynamic listening-port detection from /proc/net/{tcp,tcp6,udp,udp6}.
// Each socket is mapped to its owning process (comm, systemd unit from cgroup,
// docker-proxy target). Owners are cached by socket inode, so the /proc fd scan
// only runs when a socket we have not seen before appears.
const fsp = require('node:fs/promises');
const { aliasOf } = require('./config');
const read = (p) => fsp.readFile(p, 'utf8');

const SOURCES = [
  ['tcp', '/proc/net/tcp', '0A'], ['tcp', '/proc/net/tcp6', '0A'],
  ['udp', '/proc/net/udp', '07'], ['udp', '/proc/net/udp6', '07'],
];

// Fallback names when the owning process is not visible (non-root CLI use).
const WELL_KNOWN = {
  'tcp/21': 'ftp', 'tcp/22': 'ssh', 'tcp/25': 'smtp', 'tcp/53': 'dns', 'udp/53': 'dns', 'udp/67': 'dhcp server',
  'udp/68': 'dhcp client', 'tcp/80': 'http', 'udp/123': 'ntp', 'udp/137': 'netbios-ns', 'udp/138': 'netbios-dgm',
  'tcp/139': 'smb (netbios)', 'tcp/143': 'imap', 'tcp/443': 'https', 'udp/443': 'http/3', 'tcp/445': 'smb',
  'udp/546': 'dhcpv6 client', 'tcp/587': 'smtp submission', 'tcp/631': 'ipp/cups', 'udp/1194': 'openvpn',
  'tcp/3306': 'mysql', 'tcp/5432': 'postgres', 'udp/5353': 'mdns', 'tcp/6379': 'redis', 'tcp/27017': 'mongodb',
  'udp/51820': 'wireguard', 'tcp/2049': 'nfs', 'tcp/3389': 'rdp', 'tcp/8080': 'http-alt', 'tcp/9090': 'prometheus',
};

function hexAddr(h) {
  if (h.length === 8) return h.match(/../g).reverse().map((b) => parseInt(b, 16)).join('.');
  if (/^0+$/.test(h)) return '::';
  if (/^0{20}FFFF/i.test(h)) return hexAddr(h.slice(24));
  const hex = h.match(/.{8}/g).map((w) => w.match(/../g).reverse().join('')).join('');
  const groups = hex.match(/.{4}/g).map((g) => g.replace(/^0+(?=.)/, '').toLowerCase());
  return groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

async function readSockets() {
  const out = [];
  for (const [proto, file, state] of SOURCES) {
    const text = await read(file).catch(() => '');
    for (const l of text.split('\n').slice(1)) {
      const f = l.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== state) continue;
      const [a, p] = f[1].split(':');
      out.push({ proto, address: hexAddr(a), port: parseInt(p, 16), inode: f[9] });
    }
  }
  return out;
}

async function describePid(pid) {
  const [comm, cgroup, cmdline] = await Promise.all([
    read(`/proc/${pid}/comm`).catch(() => '?'),
    read(`/proc/${pid}/cgroup`).catch(() => ''),
    read(`/proc/${pid}/cmdline`).catch(() => ''),
  ]);
  const unitMatch = cgroup.match(/\/([^/\n]+\.(?:service|scope))(?:\/|\n|$)/);
  const info = { pid: Number(pid), comm: comm.trim(), unit: unitMatch ? unitMatch[1].replace(/\.service$/, '') : null };
  if (info.comm === 'docker-proxy') {
    const args = cmdline.split('\0');
    const cp = args[args.indexOf('-container-port') + 1];
    const ci = args[args.indexOf('-container-ip') + 1];
    if (cp) info.container = `${ci}:${cp}`;
  }
  return info;
}

class PortScanner {
  constructor(config) {
    this.configure(config);
    this.owners = new Map();  // inode -> process info
    this.seen = new Map();    // key -> last entry, for "stopped listening" detection
    this.ephemeralLow = 32768;
    read('/proc/sys/net/ipv4/ip_local_port_range').then((t) => { this.ephemeralLow = parseInt(t, 10) || 32768; }).catch(() => {});
  }

  configure(config) {
    this.cfg = config;
    this.pinnedPorts = new Set((config.pinned || []).filter((k) => /^(tcp|udp)\/\d+$/.test(k)));
    this.ignore = new Set((config.ignorePorts || []).map(String));
    // un-pinned ports that are gone should not stay "expected"
    for (const [k, v] of this.seen || []) v.expected = this.pinnedPorts.has(k);
  }

  isKnown(key) { return this.pinnedPorts.has(key) || !!this.cfg.aliases?.[key]; }

  async resolveOwners(inodes) {
    const missing = new Set(inodes.filter((i) => !this.owners.has(i)));
    if (!missing.size) return;
    for (const pid of await fsp.readdir('/proc').catch(() => [])) {
      if (!missing.size) break;
      if (!/^\d+$/.test(pid)) continue;
      const fds = await fsp.readdir(`/proc/${pid}/fd`).catch(() => null);
      if (!fds) continue;
      for (const fd of fds) {
        const link = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        if (!link.startsWith('socket:[')) continue;
        const inode = link.slice(8, -1);
        if (missing.has(inode)) {
          this.owners.set(inode, await describePid(pid));
          missing.delete(inode);
        }
      }
    }
    for (const i of missing) this.owners.set(i, null); // not visible to us; don't rescan for it
  }

  async scan() {
    const sockets = await readSockets();
    const live = new Set(sockets.map((s) => s.inode));
    for (const i of this.owners.keys()) if (!live.has(i)) this.owners.delete(i);
    // Owner lookup walks /proc/*/fd, so it only runs for stable ports: short-lived
    // listeners in the ephemeral range (dev tools, test servers) would trigger it constantly.
    const wanted = sockets.filter((s) => s.port < this.ephemeralLow || this.isKnown(`${s.proto}/${s.port}`));
    await this.resolveOwners(wanted.map((s) => s.inode));

    const byKey = new Map();
    for (const s of sockets) {
      const key = `${s.proto}/${s.port}`;
      if (this.ignore.has(String(s.port)) || this.ignore.has(key)) continue;
      const known = this.pinnedPorts.has(key) || !!this.cfg.aliases?.[key];
      const ephemeral = s.port >= this.ephemeralLow;
      // UDP: skip client sockets in the ephemeral range unless aliased/pinned
      if (s.proto === 'udp' && ephemeral && !known) continue;
      const e = byKey.get(key) || { key, proto: s.proto, port: s.port, addresses: [], owner: null, ephemeral };
      if (!e.addresses.includes(s.address)) e.addresses.push(s.address);
      e.owner ||= this.owners.get(s.inode) || null;
      byKey.set(key, e);
    }

    const ports = [];
    for (const e of byKey.values()) {
      const o = e.owner;
      e.alias = aliasOf(this.cfg, e.key, o?.unit && `unit:${o.unit}`, o?.comm && `proc:${o.comm}`);
      e.name = e.alias || o?.unit || o?.comm || WELL_KNOWN[e.key] || null;
      e.guessed = !e.alias && !o && !!WELL_KNOWN[e.key];
      e.pinned = this.pinnedPorts.has(e.key);
      e.expected = e.pinned;
      e.listening = true;
      e.status = 'ok';
      // remember non-ephemeral listeners so we can notice when they go away
      if (!e.ephemeral || e.pinned || e.alias) this.seen.set(e.key, e);
      ports.push(e);
    }
    for (const key of this.pinnedPorts) {
      if (!byKey.has(key) && !this.seen.has(key)) {
        const [proto, port] = key.split('/');
        this.seen.set(key, { key, proto, port: Number(port), addresses: [], owner: null, ephemeral: false });
      }
    }
    for (const [key, last] of this.seen) {
      if (byKey.has(key)) continue;
      const pinned = this.pinnedPorts.has(key);
      const alias = aliasOf(this.cfg, key) || last.alias || null;
      ports.push({ ...last, alias, name: alias || last.name || WELL_KNOWN[key] || null, pinned, expected: pinned,
        listening: false, status: pinned ? 'crit' : 'warn' });
    }
    ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
    return ports;
  }

  // forget ports that went away and are not pinned
  forgetGone() { for (const k of this.seen.keys()) if (!this.pinnedPorts.has(k)) this.seen.delete(k); }
}

module.exports = { PortScanner, WELL_KNOWN };
