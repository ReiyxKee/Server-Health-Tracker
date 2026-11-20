'use strict';
// Where live data comes from: the daemon's event stream when it is running,
// otherwise a collector inside this process.
const http = require('node:http');

function openSource(cfg, { local = false, onUpdate }) {
  return new Promise((resolve) => {
    const src = { kind: null, state: null, history: [], alerts: [], stop: () => {}, reconfigure: () => {} };
    const startLocal = () => {
      const { Collector } = require('./collector');
      const c = new Collector(cfg);
      c.viewers = 1;
      src.kind = 'local';
      src.history = c.history;
      src.stop = () => c.stop();
      src.reconfigure = (next) => c.reconfigure(next);
      c.on('sample', (s) => { src.state = s; onUpdate(src); });
      c.on('alert', (a) => { src.alerts.push(a); if (src.alerts.length > 200) src.alerts.shift(); onUpdate(src); });
      c.start();
      resolve(src);
    };
    if (local) return startLocal();
    const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    const req = http.get({ host, port: cfg.port, path: '/api/events', timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return startLocal(); }
      req.setTimeout(0);
      src.kind = 'daemon';
      src.stop = () => req.destroy();
      resolve(src);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'init') { src.state = d.state; src.history.splice(0, src.history.length, ...d.history); src.alerts.splice(0, src.alerts.length, ...(d.alerts || [])); }
          else if (ev === 'alert') { src.alerts.push(d); if (src.alerts.length > 200) src.alerts.shift(); }
          else if (ev === 'sample') { src.state = { ...src.state, ...d.state }; src.history.push(d.point); if (src.history.length > 600) src.history.shift(); }
          else if (ev === 'services' && src.state) src.state.services = d;
          else if (ev === 'disks' && src.state) src.state.disks = d;
          else continue;
          if (src.state) onUpdate(src);
        }
      });
      res.on('end', () => { src.kind = 'disconnected'; onUpdate(src); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { if (!src.kind) startLocal(); });
  });
}

module.exports = { openSource };
