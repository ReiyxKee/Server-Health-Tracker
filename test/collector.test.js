'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const C = require('../lib/config');
const { tokenize } = require('../lib/repl');

const SHT = path.join(__dirname, '..', 'bin', 'sht.js');
const sht = (...args) => {
  try { return execFileSync(process.execPath, [SHT, ...args], { encoding: 'utf8' }); }
  catch (e) { return e.stdout; } // non-zero exit = warn/crit
};

test('config merges user values over defaults', () => {
  const cfg = C.loadConfig(path.join(__dirname, 'fixture.config.json'));
  assert.strictEqual(cfg.port, 7999);
  assert.strictEqual(cfg.thresholds.cpu[0], 50);
  assert.deepStrictEqual(cfg.thresholds.disk, [85, 95]);
});

test('legacy services/ports keys become pins and aliases', () => {
  const u = C.normalize({ services: ['nginx'], ports: [{ port: 7001, name: 'Jellyfin', expected: true }] });
  assert.deepStrictEqual(u.pinned, ['unit:nginx', 'tcp/7001']);
  assert.strictEqual(u.aliases['tcp/7001'], 'Jellyfin');
});

test('targets parse', () => {
  assert.strictEqual(C.parseTarget('7001'), 'tcp/7001');
  assert.strictEqual(C.parseTarget('6969/udp'), 'udp/6969');
  assert.strictEqual(C.parseTarget('udp:53'), 'udp/53');
  assert.strictEqual(C.parseTarget('unit:nginx.service'), 'unit:nginx');
  assert.strictEqual(C.parseTarget('proc:jellyfin'), 'proc:jellyfin');
});

test('prompt tokenizer keeps quoted names', () => {
  assert.deepStrictEqual(tokenize('/alias 7001 "Jellyfin media"'), ['/alias', '7001', 'Jellyfin media']);
});

test('alias / pin / poll edit the config file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sht-')), 'c.json');
  sht('--config', file, 'alias', '7001', 'Jellyfin');
  sht('--config', file, 'pin', 'proc:jellyfin', 'Jellyfin', 'server');
  sht('--config', file, 'poll', '3');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.aliases['tcp/7001'], 'Jellyfin');
  assert.strictEqual(raw.aliases['proc:jellyfin'], 'Jellyfin server');
  assert.deepStrictEqual(raw.pinned, ['proc:jellyfin']);
  assert.strictEqual(raw.sampleMs, 3000);
  assert.match(sht('--config', file, 'port', '70000'), /1-65535/);
});

test('sht status --json --local returns a full snapshot', () => {
  const s = JSON.parse(sht('status', '--json', '--local'));
  for (const k of ['cpu', 'memory', 'load', 'temps', 'network', 'disks', 'services', 'checks', 'status']) assert.ok(k in s, k);
  assert.ok(s.disks.list.some((d) => d.mount === '/'));
  assert.ok(Array.isArray(s.services.ports) && Array.isArray(s.services.pinned));
});

test('web accounts: scrypt hashes, sign-in checks, edits validated', async () => {
  const U = require('../lib/users');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sht-u-'));
  const file = path.join(dir, 'users.json');
  U.writeUsers(file, { alice: { hash: await U.hashPassword('long enough'), changed: Date.now() } });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('long enough'));
  assert.strictEqual((await U.checkLogin(file, 'alice', 'long enough')).name, 'alice');
  assert.strictEqual(await U.checkLogin(file, 'alice', 'wrong'), null);
  assert.strictEqual(await U.checkLogin(file, 'bob', 'long enough'), null);
  assert.strictEqual(await U.checkLogin(file, '__proto__', 'x'), null);
  assert.throws(() => C.applyEdit({}, { action: 'pin', key: 'unit:../etc' }), /invalid target/);
  assert.deepStrictEqual(C.applyEdit({}, { action: 'pin', key: 'tcp/7001', alias: 'Jelly\u0007fin' }), { aliases: { 'tcp/7001': 'Jellyfin' }, pinned: ['tcp/7001'] });
});
