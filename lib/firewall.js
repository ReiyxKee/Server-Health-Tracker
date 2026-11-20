'use strict';
// Optional UFW integration. Rules sht adds are recorded in /etc/sht/firewall.json
// so a port change or uninstall removes exactly those rules and nothing else.
const fs = require('node:fs');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { isLocalHost } = require('./config');

const RECORD = '/etc/sht/firewall.json';
const UFW = ['/usr/sbin/ufw', '/sbin/ufw', '/usr/bin/ufw'].find((p) => fs.existsSync(p)) || null;

const records = () => { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch { return []; } };
const saveRecords = (r) => { fs.mkdirSync('/etc/sht', { recursive: true }); fs.writeFileSync(RECORD, JSON.stringify(r, null, 2) + '\n'); };
const ruleArgs = (r) => (r.from === 'any'
  ? ['allow', `${r.port}/${r.proto}`]
  : ['allow', 'proto', r.proto, 'from', r.from, 'to', 'any', 'port', String(r.port)]);
const describe = (r) => `${r.proto}/${r.port} from ${r.from}`;

function ufwActive() {
  if (!UFW || process.getuid() !== 0) return null; // unknown without root
  try { return /Status:\s*active/.test(execFileSync(UFW, ['status'], { encoding: 'utf8' })); } catch { return null; }
}

function add(r) {
  execFileSync(UFW, [...ruleArgs(r), 'comment', 'sht dashboard'], { stdio: 'inherit' });
  const all = records().filter((x) => !(x.port === r.port && x.proto === r.proto && x.from === r.from));
  all.push(r); saveRecords(all);
}

function removeAll({ except } = {}) {
  const keep = [];
  for (const r of records()) {
    if (except && except.port === r.port) { keep.push(r); continue; }
    try { execFileSync(UFW, ['delete', ...ruleArgs(r)], { stdio: 'inherit' }); console.log(`→ removed firewall rule ${describe(r)}`); }
    catch { console.log(`  (could not remove ${describe(r)}; check \`sudo ufw status numbered\`)`); }
  }
  if (UFW && records().length) saveRecords(keep);
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// Called by install and by `sht port/host`. opts: { allowFrom: [], noFirewall }
async function ensure(cfg, opts = {}) {
  const host = cfg.host;
  const previous = records();
  // the port moved: drop rules for the old port, offer the same sources for the new one
  const moved = previous.filter((r) => r.port !== cfg.port);
  if (moved.length && UFW && process.getuid() === 0) removeAll({ except: { port: cfg.port } });
  if (isLocalHost(host)) {
    if (moved.length === 0 && previous.length && UFW && process.getuid() === 0) removeAll();
    return;
  }
  if (opts.noFirewall) { console.log('→ firewall: skipped (--no-firewall)'); return; }
  const active = ufwActive();
  if (active === null) {
    console.log(`→ firewall: not managed (UFW ${UFW ? 'state unknown' : 'not installed'}). Make sure tcp/${cfg.port} is reachable on ${host}.`);
    return;
  }
  if (!active) { console.log('→ firewall: UFW inactive, no rule needed'); return; }

  let sources = opts.allowFrom?.length ? opts.allowFrom : moved.map((r) => r.from);
  if (!opts.allowFrom?.length) {
    if (!process.stdin.isTTY) {
      console.log(`→ firewall: UFW is active. To allow access run e.g.\n    sudo ufw allow proto tcp from <CIDR> to any port ${cfg.port}\n  or re-run with --allow-from <CIDR> (or --no-firewall).`);
      return;
    }
    const def = sources.length ? ` [${sources.join(' ')}]` : '';
    console.log(`\nUFW is active. sht will listen on ${host}:${cfg.port}.`);
    console.log('Allow access from which sources? CIDR(s) separated by spaces (e.g. 69.0.0.0/24 192.168.1.0/24),');
    const a = await ask(`"any", or "none" to leave the firewall alone${def}: `);
    if (a) sources = a.toLowerCase() === 'none' ? [] : a.split(/[\s,]+/).filter(Boolean);
  }
  for (const from of sources) {
    try { add({ port: cfg.port, proto: 'tcp', from }); console.log(`→ firewall: allowed tcp/${cfg.port} from ${from}`); }
    catch (e) { console.log(`  firewall rule for ${from} failed: ${e.message}`); }
  }
  if (!sources.length) console.log('→ firewall: no rule added');
}

module.exports = { ensure, removeAll, records, UFW };
