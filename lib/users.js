'use strict';
// Web dashboard accounts. Passwords are stored only as salted scrypt hashes in
// users.json next to the config file (mode 0600, owned by the service user).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { USER_FILE } = require('./config');

const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MIN_PASSWORD = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const usersFileFor = (cfgFile) => path.join(path.dirname(cfgFile || USER_FILE), 'users.json');

function readUsers(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).users || {}; }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

// Root editing the service's file keeps its owner; a new file takes the owner of
// the config next to it, so the service (user sht) can read it.
function writeUsers(file, users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let owner = null;
  for (const f of [file, path.join(path.dirname(file), 'config.json')]) {
    try { const st = fs.statSync(f); owner = [st.uid, st.gid]; break; } catch { /* next */ }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  if (owner && process.getuid() === 0) { try { fs.chownSync(tmp, owner[0], owner[1]); } catch { /* ignore */ } }
  fs.renameSync(tmp, file);
}

function scrypt(password, salt, o = SCRYPT) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 },
    (e, key) => (e ? reject(e) : resolve(key))));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A fixed dummy hash so unknown usernames take as long as wrong passwords.
let dummy = null;
async function checkLogin(file, name, password) {
  const users = readUsers(file);
  const u = Object.prototype.hasOwnProperty.call(users, name) ? users[name] : null;
  dummy ||= await hashPassword(crypto.randomBytes(12).toString('hex'));
  const ok = await verifyPassword(password, u ? u.hash : dummy);
  return ok && u ? { name, changed: u.changed } : null;
}

module.exports = { NAME_RE, MIN_PASSWORD, usersFileFor, readUsers, writeUsers, hashPassword, verifyPassword, checkLogin };
