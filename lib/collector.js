'use strict';
// Daemon-side detection. Samples the machine on fixed intervals using cheap
// /proc and /sys reads. The only subprocess is one `systemctl` call per slow
// tick. Results are kept in a ring buffer and emitted as events.
const fsp = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PortScanner } = require('./ports');
const { aliasOf, describeTarget } = require('./config');

const LEVEL = { ok: 0, warn: 1, crit: 2 };
const worst = (...s) => s.reduce((a, b) => (LEVEL[b] > LEVEL[a] ? b : a), 'ok');
const grade = (v, [w, c]) => (v >= c ? 'crit' : v >= w ? 'warn' : 'ok');
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const read = (p) => fsp.readFile(p, 'utf8');
// /proc and /sys reads never touch a disk; sync reads skip the thread pool and are ~10x cheaper.
const fs = require('node:fs');
const rs = (p, fallback) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };

const DISK_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'f2fs', 'zfs']);
const SKIP_IF = /^(lo|veth|docker|br-|virbr)/;
// os.cpus() parses /proc/cpuinfo for every core: read it once, not every tick
const CPU_INFO = (() => { const c = os.cpus(); return { model: c[0]?.model.trim(), cores: c.length }; })();

class Collector extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = config;
    this.T = config.thresholds;
    this.history = [];   // compact points for graphs
    this.state = null;   // latest full snapshot
    this.disks = { list: [], status: 'ok', checkedAt: 0 };
    this.services = { pinned: [], running: [], failed: [], ports: [], status: 'ok', checkedAt: 0 };
    this.prevCpu = null;
    this.prevNet = null;
    this.prevStatus = {};
    this.viewers = 0;             // connected dashboards/terminal UIs (set by the server)
    this.unitPaths = new Map();   // name -> cgroup dir (running services + containers)
    this.prevUnits = new Map();   // name -> { usec, t }
    this.portScanner = new PortScanner(config);
    this.timers = [];
  }

  async start() {
    this.prevCpu = await this.cpuSample();
    await Promise.all([this.tickDisks(), this.tickServices()]);
    await new Promise((r) => setTimeout(r, 300));
    await this.tickFast();
    this.schedule();
  }

  schedule() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const every = (ms, fn) => {
      let busy = false;
      this.timers.push(setInterval(async () => {
        if (busy) return; busy = true;
        try { await fn(); } catch (e) { console.error(e); } finally { busy = false; }
      }, ms));
    };
    every(Math.max(500, this.cfg.sampleMs), () => this.tickFast());
    every(Math.max(1000, this.cfg.diskMs), () => this.tickDisks());
    every(Math.max(2000, this.cfg.serviceMs), () => this.tickServices());
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // Apply a new config without restarting (aliases, pins, intervals, thresholds).
  async reconfigure(cfg) {
    const timing = ['sampleMs', 'diskMs', 'serviceMs'].some((k) => cfg[k] !== this.cfg[k]);
    this.cfg = cfg;
    this.T = cfg.thresholds;
    this.portScanner.configure(cfg);
    while (this.history.length > cfg.historyPoints) this.history.shift();
    if (timing && this.timers.length) this.schedule();
    await Promise.all([this.tickDisks(), this.tickServices()]);
    if (this.state) this.state = { ...this.state, disks: this.disks, services: this.services };
    this.emit('config', cfg);
  }

  // ---------- fast tick ----------
  async tickFast() {
    const [cpu, memory, temps, network, units] = await Promise.all([this.cpu(), this.memory(), this.temps(), this.network(), this.unitUsage()]);
    const load = this.load();
    const now = Date.now();
    const s = {
      host: os.hostname(), platform: `${os.type()} ${os.release()}`, uptime: Math.round(os.uptime()), time: now,
      cpu, memory, load, temps, network, units, disks: this.disks, services: this.services,
    };
    s.checks = {
      cpu: cpu.status, memory: memory.status, swap: memory.swap.status, load: load.status,
      temperature: temps.status, disks: this.disks.status, services: this.services.status,
    };
    s.status = worst(...Object.values(s.checks));
    this.state = s;
    const point = { t: now, cpu: cpu.usage, mem: memory.percent, rx: Math.round(network.rxRate), tx: Math.round(network.txRate) };
    this.history.push(point);
    if (this.history.length > this.cfg.historyPoints) this.history.shift();
    this.detect(s);
    this.emit('sample', s, point);
  }

  // Status-change detection: logged (journald) and emitted to clients.
  detect(s) {
    for (const [name, status] of Object.entries(s.checks)) {
      const prev = this.prevStatus[name];
      if (prev && prev !== status) {
        console.log(`[alert] ${name}: ${prev} -> ${status}`);
        this.emit('alert', { t: s.time, check: name, from: prev, to: status });
      }
      this.prevStatus[name] = status;
    }
  }

  async cpuSample() {
    return rs('/proc/stat').split('\n').filter((l) => l.startsWith('cpu')).map((l) => {
      const v = l.trim().split(/\s+/).slice(1).map(Number);
      return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
    });
  }
  async cpu() {
    const cur = await this.cpuSample();
    const pct = cur.map((c, i) => {
      const p = this.prevCpu[i]; const dt = p ? c.total - p.total : 0;
      return dt > 0 ? round(100 * (1 - (c.idle - p.idle) / dt)) : 0;
    });
    this.prevCpu = cur;
    const [usage, ...cores] = pct;
    return { usage, cores, model: CPU_INFO.model, status: grade(usage, this.T.cpu) };
  }

  async memory() {
    const m = {};
    for (const l of rs('/proc/meminfo').split('\n')) {
      const i = l.indexOf(':');
      if (i > 0) m[l.slice(0, i)] = parseInt(l.slice(i + 1), 10) * 1024;
    }
    const used = m.MemTotal - m.MemAvailable;
    const swapUsed = m.SwapTotal - m.SwapFree;
    const percent = round((100 * used) / m.MemTotal);
    const swapPct = m.SwapTotal ? round((100 * swapUsed) / m.SwapTotal) : 0;
    return {
      total: m.MemTotal, used, available: m.MemAvailable, cached: (m.Cached || 0) + (m.Buffers || 0),
      percent, status: grade(percent, this.T.memory),
      swap: { total: m.SwapTotal, used: swapUsed, percent: swapPct, status: grade(swapPct, this.T.swap) },
    };
  }

  load() {
    const [l1, l5, l15] = os.loadavg();
    const cores = CPU_INFO.cores;
    const perCore = l5 / cores;
    return { l1: round(l1, 2), l5: round(l5, 2), l15: round(l15, 2), cores, perCore: round(perCore, 2), status: grade(perCore, this.T.load) };
  }

  // Sensor file paths are discovered once (and every 5 min), then only read.
  async temps() {
    if (!this.sensors || Date.now() - this.sensorsAt > 300000) {
      this.sensorsAt = Date.now();
      this.sensors = [];
      for (const d of await fsp.readdir('/sys/class/hwmon').catch(() => [])) {
        const base = `/sys/class/hwmon/${d}`;
        const chip = (await read(`${base}/name`).catch(() => d)).trim();
        for (const f of await fsp.readdir(base).catch(() => [])) {
          const m = f.match(/^temp(\d+)_input$/);
          if (!m) continue;
          const label = (await read(`${base}/temp${m[1]}_label`).catch(() => `${chip} ${m[1]}`)).trim();
          this.sensors.push({ file: `${base}/${f}`, label });
        }
      }
    }
    const list = [];
    for (const { file, label } of this.sensors) {
      const c = parseInt(rs(file, ''), 10) / 1000;
      if (Number.isFinite(c)) list.push({ label, celsius: round(c) });
    }
    const max = list.length ? Math.max(...list.map((t) => t.celsius)) : null;
    return { list, max, status: max == null ? 'ok' : grade(max, this.T.temp) };
  }

  async network() {
    const now = Date.now();
    const ifs = {};
    for (const l of rs('/proc/net/dev').split('\n').slice(2)) {
      const [name, rest] = l.split(':');
      if (!rest || SKIP_IF.test(name.trim())) continue;
      const v = rest.trim().split(/\s+/).map(Number);
      ifs[name.trim()] = { rx: v[0], tx: v[8] };
    }
    const prev = this.prevNet;
    const dt = prev ? (now - prev.t) / 1000 : 0;
    const interfaces = Object.entries(ifs).map(([name, c]) => {
      const p = prev?.ifs[name];
      return {
        name, rxTotal: c.rx, txTotal: c.tx,
        rxRate: p && dt > 0 ? Math.max(0, (c.rx - p.rx) / dt) : 0,
        txRate: p && dt > 0 ? Math.max(0, (c.tx - p.tx) / dt) : 0,
      };
    });
    this.prevNet = { t: now, ifs };
    return {
      interfaces,
      rxRate: interfaces.reduce((a, i) => a + i.rxRate, 0),
      txRate: interfaces.reduce((a, i) => a + i.txRate, 0),
    };
  }

  // Per-service CPU% and memory from cgroup v2 accounting (no process scan).
  // Returns { name: [cpuPercent, memoryBytes] }; memory excludes inactive page cache.
  // Only computed while someone is looking (viewers > 0) and at most every serviceUsageMs:
  // it is display data, not used for alerts, and cgroup stats cost kernel time.
  async unitUsage() {
    if (this.cfg.serviceUsage === false) return {};
    const now = Date.now();
    if (!this.viewers || now - (this.unitsAt || 0) < (this.cfg.serviceUsageMs || 5000) - 100) return this.lastUnits || {};
    this.unitsAt = now;
    const freshStat = now - (this.unitStatAt || 0) > this.cfg.diskMs;
    if (freshStat) this.unitStatAt = now;
    this.inactive ||= new Map();
    const out = {};
    for (const [name, dir] of this.unitPaths) {
      const cpuStat = rs(`${dir}/cpu.stat`, null);
      if (cpuStat == null) continue;
      const usec = Number(/usage_usec (\d+)/.exec(cpuStat)?.[1] || 0);
      const p = this.prevUnits.get(name);
      const cpu = p && now > p.t ? Math.max(0, (100 * (usec - p.usec)) / ((now - p.t) * 1000)) : 0;
      this.prevUnits.set(name, { usec, t: now });
      if (freshStat || !this.inactive.has(name)) {
        this.inactive.set(name, Number(/inactive_file (\d+)/.exec(rs(`${dir}/memory.stat`, ''))?.[1] || 0));
      }
      out[name] = [round(cpu), Math.max(0, Number(rs(`${dir}/memory.current`, '0')) - this.inactive.get(name))];
    }
    for (const k of this.prevUnits.keys()) if (!this.unitPaths.has(k)) { this.prevUnits.delete(k); this.inactive.delete(k); }
    this.lastUnits = out;
    return out;
  }

  // ---------- disk tick: every real mount + expected mounts ----------
  async tickDisks() {
    const seen = new Set();
    const list = [];
    for (const l of (await read('/proc/mounts')).split('\n')) {
      const [dev, rawMount, type] = l.split(' ');
      if (!DISK_FS.has(type) || seen.has(dev)) continue;
      const mount = rawMount.replace(/\\040/g, ' ');
      if (mount.startsWith('/snap')) continue;
      seen.add(dev);
      try {
        const s = await fsp.statfs(mount);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        const used = total - s.bfree * s.bsize;
        const percent = total ? round((100 * used) / (used + free)) : 0;
        list.push({ device: dev, mount, type, total, used, free, percent, status: grade(percent, this.T.disk) });
      } catch { /* unreadable mount */ }
    }
    for (const m of this.cfg.expectedMounts) {
      if (!list.some((d) => d.mount === m)) list.push({ mount: m, missing: true, status: 'crit' });
    }
    list.sort((a, b) => a.mount.localeCompare(b.mount));
    this.disks = { list, status: worst(...list.map((d) => d.status)), checkedAt: Date.now() };
  }

  // ---------- service tick: one systemctl call + dynamic listening ports ----------
  async tickServices() {
    const out = await new Promise((resolve) => execFile('systemctl',
      ['list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager'],
      { timeout: 5000, maxBuffer: 4 << 20 }, (_e, stdout) => resolve(String(stdout || ''))));
    const units = {};
    for (const l of out.split('\n')) {
      const m = l.trim().match(/^(\S+)\.service\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (m) units[m[1]] = { name: m[1], active: m[3], sub: m[4], description: m[5] };
    }
    const all = Object.values(units);
    const cfg = this.cfg;
    const running = all.filter((u) => u.sub === 'running')
      .map(({ name, description }) => ({ name, kind: 'service', description, alias: aliasOf(cfg, `unit:${name}`) }));
    // Docker containers show up as services named after their main process.
    const CG = '/sys/fs/cgroup/system.slice';
    const paths = new Map();
    for (const r of running) paths.set(r.name, `${CG}/${r.name}.service`);
    for (const d of await fsp.readdir(CG).catch(() => [])) {
      const m = d.match(/^docker-([0-9a-f]{12})[0-9a-f]*\.scope$/);
      if (!m) continue;
      const pid = (await read(`${CG}/${d}/cgroup.procs`).catch(() => '')).split('\n')[0];
      const comm = pid ? (await read(`/proc/${pid}/comm`).catch(() => '')).trim() : '';
      const name = `docker:${comm || m[1]}`;
      running.push({ name, kind: 'container', description: `Docker container ${m[1]}`,
        alias: aliasOf(cfg, `unit:${name}`, comm && `proc:${comm}`) });
      paths.set(name, `${CG}/${d}`);
    }
    this.unitPaths = paths;
    const failed = all.filter((u) => u.active === 'failed')
      .map(({ name, description }) => ({ name, description, alias: aliasOf(cfg, `unit:${name}`), status: 'warn' }));

    const ports = await this.portScanner.scan();
    const pinned = await this.evaluatePins(units, ports);

    this.services = {
      pinned, running, failed, ports, checkedAt: Date.now(),
      status: worst(...pinned.map((p) => p.status), ...ports.map((p) => p.status), ...failed.map((f) => f.status)),
    };
  }

  async evaluatePins(units, ports) {
    const keys = this.cfg.pinned || [];
    const needProcs = keys.some((k) => k.startsWith('proc:'));
    const procs = needProcs ? await processNames() : null;
    return keys.map((key) => {
      const d = describeTarget(key);
      const alias = aliasOf(this.cfg, key);
      if (d.kind === 'port') {
        const p = ports.find((x) => x.key === key);
        const o = p?.owner;
        const detail = p?.listening ? (o ? `${o.comm}[${o.pid}]${o.unit ? ` ${o.unit}` : ''}${o.container ? ` → ${o.container}` : ''}` : p.addresses.join(', ')) : '';
        return { key, ...d, alias: alias || p?.name || null, status: p?.listening ? 'ok' : 'crit',
          state: p?.listening ? 'listening' : 'not listening', detail };
      }
      if (d.kind === 'unit') {
        const u = units[d.target];
        const state = u ? (u.sub === 'running' ? 'running' : `${u.active}/${u.sub}`) : 'not found';
        const status = u?.sub === 'running' ? 'ok' : ['activating', 'reloading'].includes(u?.active) ? 'warn' : 'crit';
        return { key, ...d, alias, status, state, detail: u?.description || '' };
      }
      const pids = procs.get(d.target) || [];
      return { key, ...d, alias, status: pids.length ? 'ok' : 'crit',
        state: pids.length ? `${pids.length} running` : 'not running', detail: pids.slice(0, 5).join(', ') };
    });
  }
}

async function processNames() {
  const map = new Map();
  for (const pid of await fsp.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const comm = (await read(`/proc/${pid}/comm`).catch(() => '')).trim();
    if (!comm) continue;
    if (!map.has(comm)) map.set(comm, []);
    map.get(comm).push(Number(pid));
  }
  return map;
}

module.exports = { Collector, worst };
