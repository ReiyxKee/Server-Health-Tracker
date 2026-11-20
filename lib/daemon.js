'use strict';
// `sht serve`: collector + HTTP/SSE server. Reloads its config live when the
// file changes (inotify on the config directory) or on SIGHUP.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { Collector } = require('./collector');
const { startServer } = require('./server');

function serve(opts) {
  const load = () => {
    const cfg = loadConfig(opts.config);
    if (opts.host) cfg.host = opts.host;
    if (opts.port) cfg.port = Number(opts.port);
    return cfg;
  };
  const cfg = load();
  let current = cfg;
  const collector = new Collector(cfg);
  collector.start().then(() => {
    const server = startServer(collector, cfg);
    console.log(`config: ${cfg.file || 'defaults only'}`);

    let timer = null;
    const reload = (why) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const next = load();
          if (next.port !== current.port) collector.portScanner.seen.delete(`tcp/${current.port}`); // our own old port
          current = next;
          await collector.reconfigure(next);
          server.reconfigure(next);
          console.log(`config reloaded (${why})`);
        } catch (e) { console.error(`config reload failed, keeping the old one: ${e.message}`); }
      }, 300);
    };
    if (cfg.file) {
      try {
        fs.watch(path.dirname(cfg.file), (_ev, name) => { if (name === path.basename(cfg.file)) reload('file changed'); });
      } catch (e) { console.error(`cannot watch ${cfg.file}: ${e.message} (use SIGHUP to reload)`); }
    }
    process.on('SIGHUP', () => reload('SIGHUP'));
    const stop = () => { collector.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

module.exports = { serve };
