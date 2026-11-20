'use strict';
// HTTP host for the dashboard + event stream. Browsers subscribe once to
// /api/events (Server-Sent Events) and receive what the daemon detects; they
// never trigger collection themselves.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_CLIENTS = 32;
const MAX_ALERTS = 100;
const RETRY_MS = 5000;

function startServer(collector, initialCfg) {
  let cfg = initialCfg;
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

  const handler = (req, res) => {
    const url = req.url.split('?')[0];
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

function json(res, data) {
  res.writeHead(data ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data ?? { error: 'collector not ready' }));
}

module.exports = { startServer };
