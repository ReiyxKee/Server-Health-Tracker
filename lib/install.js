'use strict';
// `sht install` / `sht uninstall` (run as root; the CLI re-runs itself with sudo).
// Copies this package and the running node binary into /opt/sht, so the
// service does not depend on npm, nvm or the directory it was installed from.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig, readRaw, saveRaw, normalize, SYSTEM_FILE, UNIT_FILE } = require('./config');
const firewall = require('./firewall');

const APP_ROOT = '/opt/sht';
const APP_DIR = `${APP_ROOT}/app`;
const NODE_BIN = `${APP_ROOT}/node`;
const BIN_LINK = '/usr/local/bin/sht';
const CONF_DIR = path.dirname(SYSTEM_FILE);
const PKG_DIR = path.join(__dirname, '..');
const PKG_FILES = ['bin', 'lib', 'public', 'package.json', 'config.default.json', 'README.md', 'LICENSE'];

const UNIT = `[Unit]
Description=Server Health Tracker (sht)
Documentation=https://www.npmjs.com/package/server-health-tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} --max-old-space-size=32 --max-semi-space-size=1 ${APP_DIR}/bin/sht.js serve --config ${SYSTEM_FILE}
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

# Unprivileged system user, read-only system except its own config dir (web pinning
# writes /etc/sht/config.json). The two capabilities only let it see which process
# owns each listening socket (/proc/<pid>/fd of other users).
User=sht
Group=sht
ReadWritePaths=${CONF_DIR}
AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes

# Keep the monitor from becoming the burden.
MemoryMax=96M
CPUQuota=10%
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=multi-user.target
`;

const WRAPPER = `#!/bin/sh
exec ${NODE_BIN} ${APP_DIR}/bin/sht.js "$@"
`;

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

function ensureUser() {
  try { execFileSync('id', ['-u', 'sht'], { stdio: 'ignore' }); return; } catch { /* create it */ }
  console.log('→ creating system user sht');
  sh('useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'sht']);
}
const idOf = (flag) => Number(execFileSync('id', [flag, 'sht'], { encoding: 'utf8' }).trim());

// /etc/sht: root:sht 0775 (the service may replace files in it); config.json sht:sht 0644
// (readable by the CLI for everyone); users.json (password hashes) private to the service (0600).
function fixPermissions() {
  const uid = idOf('-u'), gid = idOf('-g');
  fs.chownSync(CONF_DIR, 0, gid); fs.chmodSync(CONF_DIR, 0o775);
  fs.chownSync(SYSTEM_FILE, uid, gid); fs.chmodSync(SYSTEM_FILE, 0o644);
  const users = path.join(CONF_DIR, 'users.json');
  if (fs.existsSync(users)) { fs.chownSync(users, uid, gid); fs.chmodSync(users, 0o600); }
  fs.rmSync(path.join(CONF_DIR, 'sht.token'), { force: true }); // replaced by accounts
}

// ~/.config/sht/config.json of the user who ran `sudo sht install` (not root's home).
function invokingUserConfig() {
  const user = process.env.SUDO_USER;
  if (!user || user === 'root') return null;
  try {
    const home = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).split(':')[5];
    const file = path.join(home, '.config', 'sht', 'config.json');
    return fs.existsSync(file) ? file : null;
  } catch { return null; }
}

function copyApp() {
  if (path.resolve(PKG_DIR) !== APP_DIR) {
    console.log(`→ copying app to ${APP_DIR}`);
    fs.mkdirSync(APP_ROOT, { recursive: true });
    fs.rmSync(`${APP_DIR}.new`, { recursive: true, force: true });
    fs.mkdirSync(`${APP_DIR}.new`);
    for (const f of PKG_FILES) {
      const src = path.join(PKG_DIR, f);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(`${APP_DIR}.new`, f), { recursive: true });
    }
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    fs.renameSync(`${APP_DIR}.new`, APP_DIR);
  }
  if (path.resolve(process.execPath) !== NODE_BIN) {
    console.log(`→ copying node ${process.version} to ${NODE_BIN}`);
    fs.copyFileSync(process.execPath, `${NODE_BIN}.new`);
    fs.chmodSync(`${NODE_BIN}.new`, 0o755);
    fs.renameSync(`${NODE_BIN}.new`, NODE_BIN);
  }
  fs.chmodSync(path.join(APP_DIR, 'bin', 'sht.js'), 0o755);
  console.log(`→ installing command ${BIN_LINK}`);
  fs.writeFileSync(BIN_LINK, WRAPPER, { mode: 0o755 });
}

function removeService() {
  if (!fs.existsSync(UNIT_FILE)) return;
  try { sh('systemctl', ['disable', '--now', 'sht.service']); } catch { /* ignore */ }
  fs.rmSync(UNIT_FILE, { force: true });
  try { sh('systemctl', ['daemon-reload']); } catch { /* ignore */ }
}

async function install(opts) {
  const cliOnly = !!opts['cli-only'];
  if (!cliOnly && !fs.existsSync('/run/systemd/system')) {
    console.error('systemd not detected; use `sht serve` under your own supervisor instead.');
    process.exit(1);
  }
  copyApp();

  if (cliOnly) {
    removeService();
    console.log('\n✓ sht CLI installed (no background service). Try: sht');
    return;
  }

  // config: --config FILE replaces it, otherwise keep the existing one
  fs.mkdirSync(CONF_DIR, { recursive: true });
  let conf;
  if (opts.config) {
    conf = normalize(readRaw(path.resolve(opts.config)));
    if (fs.existsSync(SYSTEM_FILE)) fs.copyFileSync(SYSTEM_FILE, `${SYSTEM_FILE}.bak`);
    console.log(`→ config from ${opts.config} → ${SYSTEM_FILE}`);
  } else if (fs.existsSync(SYSTEM_FILE)) {
    conf = normalize(readRaw(SYSTEM_FILE));
    console.log(`→ keeping ${SYSTEM_FILE}`);
  } else {
    // first install: start from the installing user's own settings (sht port/web/alias/pin before installing)
    const userFile = invokingUserConfig();
    conf = userFile ? normalize(readRaw(userFile)) : {};
    console.log(`→ writing ${SYSTEM_FILE}${userFile ? ` (from ${userFile})` : ''}`);
  }
  if (opts.host) conf.host = opts.host;
  if (opts.port) conf.port = Number(opts.port);
  if (opts.web) conf.web = true;
  if (opts['no-web']) conf.web = false;
  saveRaw(SYSTEM_FILE, conf);
  ensureUser();
  fixPermissions();
  const cfg = loadConfig(SYSTEM_FILE);

  await firewall.ensure(cfg, { allowFrom: opts['allow-from'], noFirewall: opts['no-firewall'] });

  console.log(`→ installing ${UNIT_FILE}`);
  fs.writeFileSync(UNIT_FILE, UNIT, { mode: 0o644 });
  sh('systemctl', ['daemon-reload']);
  sh('systemctl', ['enable', 'sht.service']);
  sh('systemctl', ['restart', 'sht.service']);

  console.log(`\n✓ Server Health Tracker installed and running.
  dashboard  ${cfg.web === false ? 'off (API only; turn on with: sht web on)' : `http://${cfg.host}:${cfg.port}`}
  terminal   sht            (interactive, /help for commands)
  config     ${SYSTEM_FILE} (changes apply live)
  web edits  add an account with: sht user add <name>, then "Sign in to edit" on the dashboard`);
}

function uninstall(opts) {
  removeService();
  if (firewall.records().length) firewall.removeAll();
  fs.rmSync(BIN_LINK, { force: true });
  fs.rmSync(APP_ROOT, { recursive: true, force: true });
  if (opts.purge) {
    fs.rmSync(CONF_DIR, { recursive: true, force: true });
    try { execFileSync('userdel', ['sht'], { stdio: 'ignore' }); } catch { /* not there */ }
  }
  console.log(`✓ removed sht${opts.purge ? ' and its config' : ` (config kept in ${CONF_DIR}; --purge removes it)`}`);
}

module.exports = { install, uninstall };
