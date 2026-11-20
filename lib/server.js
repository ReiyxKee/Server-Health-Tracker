'use strict';
// HTTP host for the dashboard + event stream. Browsers subscribe once to
// /api/events (Server-Sent Events) and receive what the daemon detects; they
// never trigger collection themselves.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_CLIENTS = 32;
const MAX_ALERTS = 100;
const RETRY_MS = 5000;

// opts.edit(change, user) applies a pin/alias edit; opts.login(name, password) -> {name, changed} | null;
// opts.userValid(name, sessionCreated) says whether a session is still good (user exists, password unchanged).
const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'sht_session';

function startServer(collector, initialCfg, opts = {}) {
  let cfg = initialCfg;
  const failures = new Map(); // ip -> { n, t } failed sign-ins
  const sessions = new Map(); // id -> { user, created, expires }
  const clients = new Set();
  const alerts = [];
  const lastSent = { services: 0, disks: 0 };
  let server = null;
  let retry = null;

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };
  const fast = (s) => { const { services, disks, ...rest } = s; return rest; };

  collector.on('sample', (s, point) => {
    if (!clients.size) return;
    broadcast('sample', { state: fast(s), point });
    if (s.services.checkedAt !== lastSent.services) { lastSent.services = s.services.checkedAt; broadcast('services', s.services); }
    if (s.disks.checkedAt !== lastSent.disks) { lastSent.disks = s.disks.checkedAt; broadcast('disks', s.disks); }
  });
  collector.on('alert', (a) => {
    alerts.push(a); if (alerts.length > MAX_ALERTS) alerts.shift();
    broadcast('alert', a);
  });

  // ----- sign-in for editing (viewing needs none) -----
  const limited = (ip) => { const f = failures.get(ip); return f && f.n >= 10 && Date.now() - f.t < 60000; };
  const fail = (ip) => { const f = failures.get(ip); failures.set(ip, { n: f && Date.now() - f.t < 60000 ? f.n + 1 : 1, t: Date.now() }); };
  function cookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }
  function session(req) {
    const id = cookie(req, COOKIE);
    const s = id && sessions.get(id);
    if (!s) return null;
    if (s.expires < Date.now() || !opts.userValid?.(s.user, s.created)) { sessions.delete(id); return null; }
    return { id, ...s };
  }
  // requests from other websites are refused (SameSite=Strict cookie + Origin check)
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  const setCookie = (res, value, maxAge) => res.setHeader('set-cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);

  async function handleApi(req, res, url) {
    if (url === '/api/session' && req.method === 'GET') {
      const s = session(req);
      return json(res, { user: s?.user || null, accounts: opts.hasUsers?.() ?? false });
    }
    if (req.method !== 'POST') return json(res, { error: 'method not allowed' }, 405);
    if (!sameOrigin(req)) return json(res, { error: 'cross-site request refused' }, 403);
    const ip = req.socket.remoteAddress;
    let body = {};
    try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch (e) { return json(res, { error: `bad request: ${e.message}` }, 400); }

    if (url === '/api/login') {
      if (limited(ip)) return json(res, { error: 'too many failed sign-ins, wait a minute' }, 429);
      const u = typeof body.user === 'string' && typeof body.password === 'string' ? await opts.login(body.user, body.password) : null;
      if (!u) { fail(ip); return json(res, { error: 'wrong username or password' }, 401); }
      failures.delete(ip);
      const id = crypto.randomBytes(32).toString('base64url');
      for (const [k, v] of sessions) if (v.expires < Date.now()) sessions.delete(k);
      sessions.set(id, { user: u.name, created: Date.now(), expires: Date.now() + SESSION_MS });
      setCookie(res, id, SESSION_MS / 1000);
      console.log(`web sign-in: ${u.name} from ${ip}`);
      return json(res, { user: u.name });
    }
    if (url === '/api/logout') {
      const s = session(req);
      if (s) sessions.delete(s.id);
      setCookie(res, '', 0);
      return json(res, { ok: true });
    }
    if (url === '/api/edit') {
      const s = session(req);
      if (!s) return json(res, { error: 'sign in to edit' }, 401);
      try {
        await opts.edit(body, s.user);
        broadcast('services', collector.state?.services);
        return json(res, { ok: true });
      } catch (e) {
        const code = e.code === 'EACCES' || e.code === 'EROFS' ? 503 : 400;
        return json(res, { error: code === 503 ? `the service cannot write its config (${e.code}); re-run sht install` : e.message }, code);
      }
    }
    return json(res, { error: 'not found' }, 404);
  }

  const handler = (req, res) => {
    const url = req.url.split('?')[0];
    if (opts.edit && ['/api/session', '/api/login', '/api/logout', '/api/edit'].includes(url)) {
      handleApi(req, res, url).catch(() => { try { json(res, { error: 'internal error' }, 500); } catch { /* ignore */ } });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (url === '/api/events') {
      if (clients.size >= MAX_CLIENTS) { res.writeHead(503).end('too many clients'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      send(res, 'init', { state: collector.state, history: collector.history, alerts, sampleMs: cfg.sampleMs });
      clients.add(res);
      collector.viewers = clients.size;
      req.on('close', () => { clients.delete(res); collector.viewers = clients.size; });
      return;
    }
    if (url === '/api/health') return json(res, collector.state);
    if (url === '/api/history') return json(res, collector.history);
    if (url === '/api/alerts') return json(res, alerts);
    const st = cfg.web !== false && STATIC[url];
    if (st) {
      res.writeHead(200, { 'content-type': st[1] });
      fs.createReadStream(path.join(PUBLIC, st[0])).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  };

  function listen() {
    clearTimeout(retry);
    server = http.createServer(handler);
    server.on('error', (e) => {
      // e.g. bound to a VPN address before tun0 is up: keep retrying
      console.error(`cannot listen on ${cfg.host}:${cfg.port}: ${e.code || e.message}; retrying in ${RETRY_MS / 1000}s`);
      server.close();
      retry = setTimeout(listen, RETRY_MS);
    });
    server.listen(cfg.port, cfg.host, () => {
      console.log(`sht listening on http://${cfg.host}:${cfg.port} (web dashboard ${cfg.web === false ? 'off' : 'on'})`);
    });
  }

  function close(cb) {
    clearTimeout(retry);
    for (const res of clients) res.end();
    clients.clear();
    if (server) server.close(cb); else if (cb) cb();
    server = null;
  }

  function reconfigure(next) {
    const rebind = next.host !== cfg.host || next.port !== cfg.port;
    cfg = next;
    if (rebind) { console.log(`rebinding to ${cfg.host}:${cfg.port}`); close(() => listen()); }
    else broadcast('config', { web: cfg.web });
  }

  listen();
  return { close, reconfigure };
}

function json(res, data, status) {
  res.writeHead(status || (data ? 200 : 503), { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data ?? { error: 'collector not ready' }));
}

module.exports = { startServer };
