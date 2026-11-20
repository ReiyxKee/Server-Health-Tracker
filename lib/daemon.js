'use strict';
// `sht serve`: collector + HTTP/SSE server. Reloads its config live when the
// file changes (inotify on the config directory) or on SIGHUP.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./config');
const U = require('./users');
const { loadConfig } = C;
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
  // web editing writes the same config file the CLI edits; accounts live next to it (users.json)
  const editFile = () => current.file || C.writeTarget(opts.config);
  const usersFile = () => U.usersFileFor(editFile());
  const users = () => { try { return U.readUsers(usersFile()); } catch (e) { console.error(`cannot read ${usersFile()}: ${e.code || e.message}`); return {}; } };
  const n = Object.keys(users()).length;
  console.log(n ? `web editing: ${n} account(s) in ${usersFile()}` : 'web editing: no accounts yet (add one with: sht user add <name>)');

  collector.start().then(() => {
    let server = null;
    const apply = async (why) => {
      const next = load();
      if (next.port !== current.port) collector.portScanner.seen.delete(`tcp/${current.port}`); // our own old port
      current = next;
      await collector.reconfigure(next);
      server.reconfigure(next);
      console.log(`config reloaded (${why})`);
    };
    const edit = async (change, user) => {
      const file = editFile();
      const raw = C.normalize(C.readRaw(file));
      C.applyEdit(raw, change);
      C.saveRaw(file, raw);
      console.log(`web edit by ${user}: ${change.action} ${change.key}${change.alias ? ` "${change.alias}"` : ''}`);
      await apply('web edit');
    };
    server = startServer(collector, cfg, {
      edit,
      login: (name, password) => U.checkLogin(usersFile(), name, password).catch(() => null),
      userValid: (name, created) => { const u = users()[name]; return !!u && (!u.changed || u.changed <= created); },
      hasUsers: () => Object.keys(users()).length > 0,
    });
    console.log(`config: ${cfg.file || 'defaults only'}`);

    let timer = null;
    const reload = (why) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await apply(why);
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
