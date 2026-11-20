'use strict';
// Subscribes once to the daemon's event stream; never polls.
const STATUS_TEXT = { ok: 'Healthy', warn: 'Warning', crit: 'Critical', unknown: 'Unknown' };
const STATUS_ICON = { ok: '✓', warn: '!', crit: '×', unknown: '?' };
let points = [];
let windowMs = 600000;
let state = null;

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const rate = (n) => `${bytes(n)}/s`;
const pct = (v) => `${v.toFixed(1)}%`;
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const badge = (s) => `<span class="icon" data-status="${s}" aria-hidden="true">${STATUS_ICON[s]}</span>`;
const statusCell = (s, text) => `<span class="st" data-status="${s}">${badge(s)}${esc(text ?? STATUS_TEXT[s])}</span>`;
const bar = (p, s) => `<div class="bar" data-status="${s}"><span style="width:${Math.min(100, p)}%"></span></div>`;

function statusLine(el, s, text) {
  el.innerHTML = statusCell(s, text);
}

// ---------- charts: time-based x, crosshair tooltip ----------
function drawChart(svg, series, { max, fmt, axis }) {
  const w = svg.clientWidth, h = svg.clientHeight;
  if (!w || !h) return;
  const padL = axis ? 64 : 0, padT = 6, padB = axis ? 18 : 2;
  const now = points.length ? points[points.length - 1].t : Date.now();
  const t0 = now - windowMs;
  const pts = points.filter((p) => p.t >= t0);
  const top = max ?? niceMax(Math.max(1, ...pts.flatMap((p) => series.map((s) => p[s.key]))));
  const x = (t) => padL + ((t - t0) / windowMs) * (w - padL);
  const y = (v) => padT + (h - padT - padB) * (1 - Math.min(v, top) / top);
  let out = '';
  if (axis) {
    for (const f of [0, 0.5, 1]) {
      out += `<line class="${f === 0 ? 'baseline' : 'gridline'}" x1="${padL}" x2="${w}" y1="${y(top * f)}" y2="${y(top * f)}"/>`;
      out += `<text x="${padL - 8}" y="${y(top * f) + 4}" text-anchor="end">${fmt(top * f)}</text>`;
    }
    out += `<text x="${padL}" y="${h - 2}">−${Math.round(windowMs / 60000)} min</text><text x="${w}" y="${h - 2}" text-anchor="end">now</text>`;
  } else {
    out += `<line class="baseline" x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}"/>`;
  }
  if (pts.length > 1) {
    for (const s of series) {
      const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
      if (s.area) out += `<polygon class="area ${s.cls}" points="${x(pts[0].t)},${y(0)} ${line} ${x(pts[pts.length - 1].t)},${y(0)}"/>`;
      out += `<polyline class="line ${s.cls}" points="${line}"/>`;
    }
  }
  out += '<g class="hover"></g>';
  svg.innerHTML = out;
  svg._chart = { series, pts, x, y, fmt, h };
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v)); const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function attachHover(svg) {
  const tip = $('#tip');
  svg.addEventListener('pointermove', (e) => {
    const c = svg._chart; if (!c || !c.pts.length) return;
    const mx = e.clientX - svg.getBoundingClientRect().left;
    let best = c.pts[0];
    for (const p of c.pts) if (Math.abs(c.x(p.t) - mx) < Math.abs(c.x(best.t) - mx)) best = p;
    const px = c.x(best.t);
    $('.hover', svg).innerHTML = `<line class="cross" x1="${px}" x2="${px}" y1="0" y2="${c.h}"/>` +
      c.series.map((s) => `<circle class="dot ${s.cls}" cx="${px}" cy="${c.y(best[s.key])}" r="4"/>`).join('');
    tip.innerHTML = `<div class="t">${clock(best.t)}</div>` + c.series.map((s) =>
      `<div>${c.series.length > 1 ? `<span class="swatch ${s.cls}"></span>` : ''}${esc(s.name)}: <b>${c.fmt(best[s.key])}</b></div>`).join('');
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 12}px`;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; const g = $('.hover', svg); if (g) g.innerHTML = ''; });
}
document.querySelectorAll('svg[data-chart]').forEach(attachHover);

function drawCharts() {
  drawChart($('[data-chart="cpu"]'), [{ key: 'cpu', name: 'CPU', cls: 's1', area: true }], { max: 100, fmt: pct });
  drawChart($('[data-chart="mem"]'), [{ key: 'mem', name: 'Memory', cls: 's1', area: true }], { max: 100, fmt: pct });
  drawChart($('[data-chart="net"]'), [
    { key: 'rx', name: 'Download', cls: 's1' },
    { key: 'tx', name: 'Upload', cls: 's2' },
  ], { fmt: rate, axis: true });
}

// ---------- render ----------
function renderFast(s) {
  document.title = `${STATUS_ICON[s.status]} ${s.host} · Server Health Tracker`;
  $('#host').textContent = s.host;
  $('#platform').textContent = `${s.platform} · ${s.cpu.model || ''}`;
  const pill = $('#overall');
  pill.dataset.status = s.status;
  $('.icon', pill).textContent = STATUS_ICON[s.status];
  const bad = Object.entries(s.checks).filter(([, v]) => v !== 'ok').map(([k]) => k);
  $('.label', pill).textContent = bad.length ? `${STATUS_TEXT[s.status]}: ${bad.join(', ')}` : STATUS_TEXT[s.status];

  $('#t-cpu .val').textContent = s.cpu.usage.toFixed(1);
  statusLine($('#t-cpu .status-line'), s.cpu.status);
  $('#t-mem .val').textContent = s.memory.percent.toFixed(1);
  statusLine($('#t-mem .status-line'), s.memory.status, `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`);
  $('#t-load .val').textContent = s.load.l1.toFixed(2);
  statusLine($('#t-load .status-line'), s.load.status, `${s.load.perCore} per core (5 min)`);
  $('#t-load .detail').textContent = `5 min ${s.load.l5} · 15 min ${s.load.l15} · ${s.load.cores} cores`;
  $('#t-temp .val').textContent = s.temps.max ?? '–';
  statusLine($('#t-temp .status-line'), s.temps.status);
  $('#t-temp .detail').textContent = s.temps.list.length ? `${s.temps.list.length} sensors` : 'no sensors found';
  $('#t-up .val').textContent = duration(s.uptime);
  const sw = s.memory.swap;
  if (sw.total) statusLine($('#swap'), sw.status, `Swap ${bytes(sw.used)} / ${bytes(sw.total)}`);
  else $('#swap').textContent = 'No swap';
  renderIfaces(s.network);
  $('#rx').textContent = rate(s.network.rxRate);
  $('#tx').textContent = rate(s.network.txRate);
  $('#cores').innerHTML = s.cpu.cores.map((c, i) =>
    `<li class="row"><span class="name">Core ${i}</span><span class="meta">${c.toFixed(1)}%</span>${bar(c, 'ok')}</li>`).join('');
}

function renderDisks(d) {
  $('#disks').innerHTML = d.list.map((x) => x.missing
    ? `<tr class="gone"><td>${statusCell('crit', 'missing')}</td><td><b>${esc(x.mount)}</b></td><td colspan="6">expected mount is not mounted</td></tr>`
    : `<tr>
        <td>${statusCell(x.status)}</td><td><b>${esc(x.mount)}</b></td><td class="muted">${esc(x.device)}</td><td class="muted">${esc(x.type)}</td>
        <td><b>${x.percent.toFixed(1)}%</b>${bar(x.percent, x.status)}</td>
        <td class="num">${bytes(x.used)}</td><td class="num">${bytes(x.free)}</td><td class="num">${bytes(x.total)}</td>
      </tr>`).join('');
}

function renderIfaces(n) {
  $('#ifaces').innerHTML = n.interfaces.map((i) => `<tr>
    <td>${esc(i.name)}</td><td class="num">${rate(i.rxRate)}</td><td class="num">${rate(i.txRate)}</td>
    <td class="num muted">${bytes(i.rxTotal)}</td><td class="num muted">${bytes(i.txTotal)}</td></tr>`).join('');
}

// ---------- sortable tables (sorting is done here in the browser) ----------
const sorts = { ports: { key: 'port', dir: 1 }, services: { key: 'cpu', dir: -1 } };
const ASC_FIRST = new Set(['port', 'name', 'process', 'unit', 'bind', 'description', 'status']);
const RANK = { crit: 0, warn: 1, ok: 2 };
function cmp(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return String(a ?? '').localeCompare(String(b ?? ''));
  return (a ?? -1) - (b ?? -1);
}
function sortRows(rows, st, get, pinRank) {
  return rows.sort((a, b) => (pinRank(a) - pinRank(b)) || cmp(get(a, st.key), get(b, st.key)) * st.dir);
}
function wireSort(table, name, rerender) {
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const st = sorts[name];
      if (st.key === th.dataset.sort) st.dir = -st.dir;
      else { st.key = th.dataset.sort; st.dir = ASC_FIRST.has(st.key) ? 1 : -1; }
      rerender();
    });
  });
}
function markSort(table, name) {
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    if (th.dataset.sort === sorts[name].key) th.setAttribute('aria-sort', sorts[name].dir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}

function renderPorts() {
  const sv = state?.services; if (!sv) return;
  $('#ports-age').textContent = `checked ${clock(sv.checkedAt)}`;
  const showEph = $('#show-ephemeral').checked;
  const order = new Map((sv.pinned || []).map((p, i) => [p.key, i]));
  const get = (p, k) => ({
    status: RANK[p.status], port: p.port, name: (p.alias || p.name || '').toLowerCase(),
    process: p.owner?.comm || '', unit: p.owner?.unit || '', bind: p.addresses.join(','),
  }[k]);
  const q = $('#port-filter').value.trim().toLowerCase();
  const match = (p) => !q || [String(p.port), p.alias || '', p.name || '', p.owner?.comm || '', p.owner?.unit || ''].some((x) => x.toLowerCase().includes(q));
  const listening = sv.ports.filter((p) => p.listening).length;
  $('#tab-ports-count').textContent = listening;
  const rows = sortRows(sv.ports.filter((p) => (showEph || !p.ephemeral || !p.listening || p.pinned) && match(p)), sorts.ports, get,
    (p) => (order.has(p.key) ? 0 : 1)); // pinned group on top, sorted like the rest
  markSort($('#ports').closest('table'), 'ports');
  $('#ports').innerHTML = rows.map((p) => {
    const o = p.owner;
    const proc = o ? `${esc(o.comm)} <span class="muted">${o.pid}</span>${o.container ? ` <span class="muted">→ ${esc(o.container)}</span>` : ''}` : '<span class="muted">—</span>';
    return `<tr class="${p.listening ? '' : 'gone'} ${order.has(p.key) ? 'pinned' : ''}">
      <td>${statusCell(p.status, p.listening ? 'listening' : 'stopped')}</td>
      <td class="num">${p.port}<span class="muted">/${p.proto}</span></td>
      <td>${editButtons(p.key, order.has(p.key), p.alias)}${order.has(p.key) ? '📌 ' : ''}${p.alias ? `<span class="alias">${esc(p.alias)}</span>` : esc(p.name || '—')}${p.guessed ? ' <span class="muted">(guess)</span>' : ''}</td>
      <td>${proc}</td>
      <td>${esc(o?.unit || '')}</td>
      <td class="bind">${esc(p.addresses.join(', '))}</td>
    </tr>`;
  }).join('');
}

function renderServicesTable() {
  const sv = state?.services; if (!sv) return;
  const units = state.units || {};
  const pinnedUnits = (sv.pinned || []).filter((p) => p.kind === 'unit');
  const order = new Map(pinnedUnits.map((p, i) => [p.target, i]));
  const items = [];
  for (const p of pinnedUnits) items.push({ name: p.target, alias: p.alias, state: p.state, status: p.status, description: p.detail });
  for (const f of sv.failed) if (!order.has(f.name)) items.push({ name: f.name, alias: f.alias, state: 'failed', status: 'crit', description: f.description });
  for (const r of sv.running) if (!order.has(r.name)) items.push({ name: r.name, alias: r.alias, state: 'running', status: 'ok', description: r.description, kind: r.kind });
  const pinnedKeys = new Set((sv.pinned || []).map((p) => p.key));
  for (const i of items) i.key = i.kind === 'container' ? `proc:${i.name.replace(/^docker:/, '')}` : `unit:${i.name}`;
  const q = $('#svc-filter').value.trim().toLowerCase();
  const list = items.filter((i) => !q || [i.name, i.alias || '', i.description || ''].some((x) => x.toLowerCase().includes(q)));
  const get = (i, k) => ({
    status: RANK[i.status], name: (i.alias || i.name).toLowerCase(), cpu: units[i.name]?.[0] ?? null,
    mem: units[i.name]?.[1] ?? null, unit: i.name, description: i.description || '',
  }[k]);
  sortRows(list, sorts.services, get, (i) => (order.has(i.name) || pinnedKeys.has(i.key) ? 0 : 1));
  markSort($('#services-table'), 'services');
  const total = Object.values(units).reduce((n, u) => n + u[0], 0);
  $('#running-count').textContent = `${sv.running.length} running · ${sv.failed.length} failed · ${total.toFixed(1)}% CPU in services`;
  $('#svc-count').textContent = `${sv.running.length} services running · ${sv.failed.length} failed`;
  $('#tab-services-count').textContent = sv.running.length;
  $('#services').innerHTML = list.map((i) => {
    const u = units[i.name];
    return `<tr class="${order.has(i.name) || pinnedKeys.has(i.key) ? 'pinned' : ''}">
      <td>${statusCell(i.status, i.state)}</td>
      <td>${editButtons(i.key, pinnedKeys.has(i.key), i.alias)}${pinnedKeys.has(i.key) ? '📌 ' : ''}${i.alias ? `<span class="alias">${esc(i.alias)}</span>` : esc(i.name)}</td>
      <td class="num">${u ? u[0].toFixed(1) : '<span class="muted">—</span>'}</td>
      <td class="num">${u ? bytes(u[1]) : '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(i.kind === 'container' ? `${i.name} (container)` : i.name)}</td>
      <td class="muted">${esc(i.description || '')}</td>
    </tr>`;
  }).join('');
}

function renderServices() {
  renderPorts();
  renderServicesTable();
  renderAlerts();
}
wireSort($('#ports').closest('table'), 'ports', renderPorts);
wireSort($('#services-table'), 'services', renderServicesTable);
$('#svc-filter').addEventListener('input', renderServicesTable);
$('#show-ephemeral').addEventListener('change', renderPorts);
$('#port-filter').addEventListener('input', renderPorts);

// ---------- alerts: current issues (computed here from the snapshot) + points ----------
const alerts = [];
let seenAlerts = 0;
const fmtPct = (v) => `${Number(v).toFixed(1)}%`;
function currentIssues(s) {
  if (!s) return [];
  const out = [];
  const add = (level, area, text) => { if (level !== 'ok') out.push({ level, area, text }); };
  add(s.cpu.status, 'cpu', `CPU at ${fmtPct(s.cpu.usage)}`);
  add(s.memory.status, 'memory', `Memory at ${fmtPct(s.memory.percent)}`);
  add(s.memory.swap.status, 'swap', `Swap at ${fmtPct(s.memory.swap.percent)}`);
  add(s.load.status, 'load', `Load ${s.load.l5} over 5 min (${s.load.perCore} per core)`);
  add(s.temps.status, 'temperature', `Hottest sensor at ${s.temps.max}°C`);
  for (const d of s.disks?.list || []) {
    if (d.missing) add('crit', 'mount', `${d.mount} is not mounted`);
    else add(d.status, 'disk', `${d.mount} is ${fmtPct(d.percent)} full (${d.device})`);
  }
  const sv = s.services;
  if (sv) {
    for (const p of sv.pinned || []) add(p.status, `pinned ${p.kind}`, `${p.alias || p.target} (${p.target}): ${p.state}`);
    const pinned = new Set((sv.pinned || []).map((p) => p.key));
    for (const p of sv.ports || []) if (!p.listening && !pinned.has(p.key)) add(p.status, 'port', `${p.alias || p.name || 'port'} ${p.port}/${p.proto} stopped listening`);
    for (const f of sv.failed || []) add('warn', 'failed unit', `${f.alias ? `${f.alias} (${f.name})` : f.name} failed${f.description ? ` — ${f.description}` : ''}`);
  }
  return out.sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1));
}

function renderAlerts() {
  const list = currentIssues(state);
  const worst = list.some((i) => i.level === 'crit') ? 'crit' : list.length ? 'warn' : 'ok';
  const n = $('#notify');
  n.dataset.status = worst;
  $('.icon', n).textContent = STATUS_ICON[worst];
  $('#notify-count').textContent = list.length;
  n.title = list.length ? `${list.length} issue(s) — open Alerts` : 'No issues — open Alerts';
  if (currentTab === 'alerts') seenAlerts = alerts.length;
  $('#notify-dot').hidden = alerts.length <= seenAlerts;
  $('#tab-alerts-count').textContent = list.length || '';

  $('#issues-summary').textContent = list.length ? `${list.length} issue(s)` : 'all clear';
  $('#issues').innerHTML = list.length
    ? list.map((i) => `<li>${badge(i.level)}<span class="level ${i.level}">${i.level === 'crit' ? 'ERROR' : 'WARN'}</span><span class="area">${esc(i.area)}</span><span>${esc(i.text)}</span></li>`).join('')
    : `<li>${badge('ok')} Nothing needs attention.</li>`;
  $('#alerts').innerHTML = alerts.length
    ? alerts.slice().reverse().map((a) => `<li class="alert-row"><time>${new Date(a.t).toLocaleString()}</time>${badge(a.to)}<span><b>${esc(a.check)}</b> ${esc(a.from)} → ${esc(a.to)}</span></li>`).join('')
    : '<li class="sub">No status changes since the daemon started.</li>';
}


// ---------- editing (pin / alias): sign in with a server account (sht user add <name>) ----------
let signedIn = null;   // username while signed in (session cookie is HttpOnly, the page never sees it)
let hasAccounts = true;
function setUnlocked(user) {
  signedIn = user;
  document.body.classList.toggle('unlocked', !!user);
  const b = $('#lock');
  b.dataset.unlocked = String(!!user);
  b.textContent = user ? `👤 ${user} · Sign out` : '🔒 Sign in to edit';
}
function editButtons(key, pinned, alias) {
  return `<button class="edit-btn" type="button" data-act="${pinned ? 'unpin' : 'pin'}" data-key="${esc(key)}" aria-pressed="${pinned}" title="${pinned ? 'Unpin' : 'Pin to top and alert when it goes down'}">📌</button>`
    + `<button class="edit-btn" type="button" data-act="alias" data-key="${esc(key)}" data-alias="${esc(alias || '')}" title="Rename (alias)">✎</button>`;
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}
async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
async function edit(change) {
  try {
    await api('/api/edit', change);
    toast({ pin: '📌 pinned', unpin: 'unpinned', alias: change.alias ? `renamed to “${change.alias}”` : 'alias removed' }[change.action] || 'saved');
  } catch (e) {
    if (e.status === 401) { setUnlocked(null); openSignIn('Your session ended. Sign in again.'); }
    else toast(`⚠ ${e.message}`);
  }
}
function openSignIn(err) {
  $('#no-accounts').hidden = hasAccounts;
  $('#unlock-error').hidden = !err; $('#unlock-error').textContent = err || '';
  $('#password-input').value = '';
  $('#unlock-dialog').showModal();
  $(hasAccounts && $('#user-input').value ? '#password-input' : '#user-input').focus?.();
}
$('#lock').addEventListener('click', async () => {
  if (!signedIn) return openSignIn();
  try { await api('/api/logout'); } catch { /* ignore */ }
  setUnlocked(null);
  toast('signed out');
});
$('#unlock-cancel').addEventListener('click', () => $('#unlock-dialog').close());
$('#unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/login', { user: $('#user-input').value.trim(), password: $('#password-input').value });
    $('#password-input').value = '';
    setUnlocked(r.user);
    $('#unlock-dialog').close();
    toast(`🔓 signed in as ${r.user}`);
  } catch (err) {
    $('#password-input').value = '';
    $('#unlock-error').hidden = false;
    $('#unlock-error').textContent = err.message;
  }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.edit-btn'); if (!b) return;
  if (!signedIn) return openSignIn();
  const key = b.dataset.key;
  if (b.dataset.act === 'alias') {
    const name = window.prompt(`Name for ${key} (empty removes the alias):`, b.dataset.alias || '');
    if (name === null) return;
    edit({ action: 'alias', key, alias: name.trim() });
  } else edit({ action: b.dataset.act, key });
});
api('/api/session', null, 'GET').then((r) => { hasAccounts = r.accounts; setUnlocked(r.user); }).catch(() => setUnlocked(null));

// ---------- tabs (state kept in the URL hash, e.g. #ports) ----------
const TABS = ['overview', 'ports', 'services', 'alerts'];
let currentTab = 'overview';
function showTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  currentTab = name;
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== name;
  if (location.hash.slice(1) !== name) window.history.replaceState(null, '', `#${name}`);
  if (name === 'overview') drawCharts(); // charts can't measure while hidden
  if (name === 'alerts') { seenAlerts = alerts.length; }
  if (state) renderAlerts();
}
document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#notify').addEventListener('click', () => showTab('alerts'));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input') || e.ctrlKey || e.metaKey || e.altKey) return;
  const i = Number(e.key);
  if (i >= 1 && i <= TABS.length) showTab(TABS[i - 1]);
  if (e.key === 'a') showTab('alerts');
});
showTab(location.hash.slice(1) || 'overview');

// ---------- event stream ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    state = d.state; points = d.history;
    windowMs = Math.max(60000, (d.history.length ? d.history.length : 1) * d.sampleMs, 300 * d.sampleMs);
    alerts.length = 0; alerts.push(...d.alerts);
    seenAlerts = alerts.length; // only changes after the page opened count as new
    renderFast(state); renderDisks(state.disks); renderServices(); drawCharts();
  });
  es.addEventListener('sample', (e) => {
    const d = JSON.parse(e.data);
    state = { ...state, ...d.state };
    points.push(d.point);
    const cutoff = d.point.t - windowMs;
    while (points.length && points[0].t < cutoff) points.shift();
    renderFast(state); if (currentTab === 'overview') drawCharts(); renderServicesTable(); renderAlerts();
  });
  es.addEventListener('disks', (e) => { state.disks = JSON.parse(e.data); renderDisks(state.disks); renderAlerts(); });
  es.addEventListener('services', (e) => { state.services = JSON.parse(e.data); renderServices(); });
  es.addEventListener('alert', (e) => { alerts.push(JSON.parse(e.data)); renderAlerts(); });
  es.onerror = () => {
    const pill = $('#overall');
    pill.dataset.status = 'crit';
    $('.icon', pill).textContent = '×';
    $('.label', pill).textContent = 'Daemon unreachable · retrying';
  };
}
window.addEventListener('resize', drawCharts);
// the clock ticks every second, independent of the sampling rate
(function tickClock() {
  $('#updated').textContent = `Live · ${clock(Date.now())}`;
  setTimeout(tickClock, 1000 - (Date.now() % 1000) + 5);
})();
connect();
