'use strict';
// Top-like process sampler, used only by the interactive terminal UI
// (the daemon never runs it). Per-process details are cached by pid+starttime.
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const CLK_TCK = 100;
const PAGE = 4096;

function users() {
  const map = new Map();
  try {
    for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = l.split(':'); if (f.length > 2) map.set(Number(f[2]), f[0]);
    }
  } catch { /* ignore */ }
  return map;
}

class ProcSampler {
  constructor() {
    this.prev = new Map();   // pid -> { ticks }
    this.info = new Map();   // pid -> { start, user, cmd, unit }
    this.prevT = 0;
    this.users = users();
    this.memTotal = 0;
  }

  async sample() {
    if (!this.memTotal) {
      const m = (await fsp.readFile('/proc/meminfo', 'utf8')).match(/MemTotal:\s+(\d+)/);
      this.memTotal = m ? Number(m[1]) * 1024 : 1;
    }
    const now = Date.now();
    const dt = this.prevT ? (now - this.prevT) / 1000 : 0;
    const list = [];
    const seen = new Set();
    for (const pid of await fsp.readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(pid)) continue;
      const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
      if (!stat) continue;
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).split(' ');
      const ppid = Number(f[1]);
      const ticks = Number(f[11]) + Number(f[12]);
      const start = f[19];
      const rss = Number(f[21]) * PAGE;
      const p = this.prev.get(pid);
      const cpu = p && p.start === start && dt > 0 ? (100 * (ticks - p.ticks)) / (dt * CLK_TCK) : 0;
      this.prev.set(pid, { ticks, start });
      seen.add(pid);
      list.push({ pid: Number(pid), ppid, comm, start, cpu: Math.max(0, cpu), rss, mem: (100 * rss) / this.memTotal, kernel: ppid === 2 || pid === '2' });
    }
    for (const k of this.prev.keys()) if (!seen.has(k)) { this.prev.delete(k); this.info.delete(k); }
    this.prevT = now;
    this.count = list.length;
    return list;
  }

  // Fill in user / command line / systemd unit for the rows actually shown.
  async details(rows) {
    for (const r of rows) {
      const key = String(r.pid);
      let i = this.info.get(key);
      if (!i || i.start !== r.start) {
        const [st, cmdline, cgroup] = await Promise.all([
          fsp.stat(`/proc/${r.pid}`).catch(() => null),
          fsp.readFile(`/proc/${r.pid}/cmdline`, 'utf8').catch(() => ''),
          fsp.readFile(`/proc/${r.pid}/cgroup`, 'utf8').catch(() => ''),
        ]);
        const docker = cgroup.match(/docker[-/]([0-9a-f]{12})/)?.[1];
        const unit = cgroup.match(/\/([^/\n]+)\.service(?:\/|\n|$)/)?.[1] || (docker ? `docker:${docker}` : null);
        i = { start: r.start, user: st ? (this.users.get(st.uid) ?? String(st.uid)) : '?', cmd: cmdline.split('\0').filter(Boolean).join(' ').replace(/\s+/g, ' ') || `[${r.comm}]`, unit };
        this.info.set(key, i);
      }
      Object.assign(r, { user: i.user, cmd: i.cmd, unit: i.unit });
    }
    return rows;
  }
}

module.exports = { ProcSampler };
