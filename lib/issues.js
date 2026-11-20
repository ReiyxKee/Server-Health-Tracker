'use strict';
// Current problems derived from a snapshot: what the notification badge counts
// and what the Alerts tab lists.
const pct = (v) => `${Number(v).toFixed(1)}%`;

function issues(s) {
  if (!s) return [];
  const out = [];
  const add = (level, area, text) => { if (level !== 'ok') out.push({ level, area, text }); };
  const T = s.thresholds || {};
  add(s.cpu.status, 'cpu', `CPU at ${pct(s.cpu.usage)}`);
  add(s.memory.status, 'memory', `Memory at ${pct(s.memory.percent)}`);
  add(s.memory.swap.status, 'swap', `Swap at ${pct(s.memory.swap.percent)}`);
  add(s.load.status, 'load', `Load ${s.load.l5} over 5 min (${s.load.perCore} per core)`);
  add(s.temps.status, 'temperature', `Hottest sensor at ${s.temps.max}°C`);
  for (const d of s.disks?.list || []) {
    if (d.missing) add('crit', 'mount', `${d.mount} is not mounted`);
    else add(d.status, 'disk', `${d.mount} is ${pct(d.percent)} full (${d.device})`);
  }
  const sv = s.services;
  if (sv) {
    for (const p of sv.pinned || []) add(p.status, `pinned ${p.kind}`, `${p.alias || p.target} (${p.target}): ${p.state}`);
    const pinnedKeys = new Set((sv.pinned || []).map((p) => p.key));
    for (const p of sv.ports || []) {
      if (!p.listening && !pinnedKeys.has(p.key)) add(p.status, 'port', `${p.alias || p.name || 'port'} ${p.port}/${p.proto} stopped listening`);
    }
    for (const f of sv.failed || []) add('warn', 'failed unit', `${f.alias ? `${f.alias} (${f.name})` : f.name} failed${f.description ? ` — ${f.description}` : ''}`);
  }
  const order = { crit: 0, warn: 1 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

module.exports = { issues };
