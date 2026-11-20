'use strict';
// Terminal rendering for `sht status` / `sht watch`.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), green = c(32), yellow = c(33), red = c(31), cyan = c(36);
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const ICON = { ok: green('✓ ok  '), warn: yellow('! warn'), crit: red('× crit') };
const color = { ok: green, warn: yellow, crit: red };

const bytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const bar = (pct, status, width = 20) => {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return (color[status] || cyan)('█'.repeat(n)) + dim('░'.repeat(width - n));
};
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function renderStatus(s, opts = {}) {
  const all = !opts['no-ephemeral'];
  const o = [];
  o.push(`${bold(s.host)}  ${dim(s.platform)}  up ${duration(s.uptime)}   overall ${ICON[s.status]}`);
  o.push('');
  o.push(`${pad('CPU', 10)}${bar(s.cpu.usage, s.cpu.status)} ${lpad(s.cpu.usage.toFixed(1), 5)}%  ${ICON[s.cpu.status]}`);
  o.push(`${pad('Memory', 10)}${bar(s.memory.percent, s.memory.status)} ${lpad(s.memory.percent.toFixed(1), 5)}%  ${ICON[s.memory.status]}  ${dim(`${bytes(s.memory.used)} / ${bytes(s.memory.total)}`)}`);
  if (s.memory.swap.total) o.push(`${pad('Swap', 10)}${bar(s.memory.swap.percent, s.memory.swap.status)} ${lpad(s.memory.swap.percent.toFixed(1), 5)}%  ${ICON[s.memory.swap.status]}`);
  o.push(`${pad('Load', 10)}${s.load.l1} ${s.load.l5} ${s.load.l15}  ${dim(`(${s.load.perCore}/core)`)}  ${ICON[s.load.status]}`);
  if (s.temps.max != null) o.push(`${pad('Temp', 10)}${s.temps.max}°C  ${ICON[s.temps.status]}`);
  o.push(`${pad('Network', 10)}↓ ${bytes(s.network.rxRate)}/s  ↑ ${bytes(s.network.txRate)}/s`);

  if (s.disks) {
    o.push('', bold('Storage'));
    for (const d of s.disks.list) {
      o.push(d.missing
        ? `  ${pad(d.mount, 22)}${red('NOT MOUNTED')}  ${ICON.crit}`
        : `  ${pad(d.mount, 22)}${bar(d.percent, d.status)} ${lpad(d.percent.toFixed(1), 5)}%  ${ICON[d.status]}  ${dim(`${bytes(d.used)} / ${bytes(d.total)} ${d.type}`)}`);
    }
  }
  if (s.services) {
    const sv = s.services;
    if (sv.pinned?.length) o.push('', bold('Pinned'), renderPinned(sv.pinned));
    if (sv.failed.length) {
      o.push('', bold(red('Failed units')));
      for (const f of sv.failed) o.push(`  ${ICON.warn}  ${pad(f.alias || f.name, 28)}${dim(f.alias ? f.name : f.description)}`);
    }
    o.push('', bold('Listening ports') + dim(all ? '' : '  (ephemeral hidden)'));
    for (const p of sv.ports) {
      if (p.ephemeral && !all && p.listening && !p.pinned) continue;
      const name = p.alias ? bold(p.alias) : (p.name || '—');
      o.push(`  ${ICON[p.status]}  ${lpad(p.port, 5)}/${pad(p.proto, 4)} ${pad(name, 26 + (name.length - stripAnsi(name).length))}${dim(portDetail(p))}`);
    }
    o.push('', dim(`${sv.running.length} services running · ${sv.failed.length} failed`));
  }
  return o.join('\n');
}

function renderPinned(pins) {
  if (!pins?.length) return '';
  return pins.map((p) => {
    const label = p.alias || p.target;
    const what = p.kind === 'port' ? p.target : p.kind === 'unit' ? `unit ${p.target}` : `proc ${p.target}`;
    return `  ${ICON[p.status]}  ${pad(label, 26)}${pad(what, 30)}${p.status === 'ok' ? dim(p.state) : red(p.state)}  ${dim(p.detail || '')}`;
  }).join('\n');
}

function portDetail(p) {
  if (!p.listening) return red('stopped listening');
  const parts = [p.addresses.join(', ')];
  if (p.owner) parts.push(`${p.owner.comm}[${p.owner.pid}]${p.owner.unit ? ` ${p.owner.unit}` : ''}${p.owner.container ? ` → ${p.owner.container}` : ''}`);
  return parts.join('  ');
}

module.exports = { renderStatus, renderPinned, bytes, bold, dim, red, green, yellow, cyan };
