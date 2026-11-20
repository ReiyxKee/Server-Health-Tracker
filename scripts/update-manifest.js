#!/usr/bin/env node
'use strict';
// Release helper used by .github/workflows/release.yml (same channel model as Movie Curator).
//
//   node scripts/update-manifest.js <version> <tag> <channel> <download-url> <tarball> [notes-file]
//
// Channels:
//   stable        manifest.json               stable releases only
//   experimental  manifest-experimental.json  stable + experimental releases
// A stable release goes into both files, an experimental one only into manifest-experimental.json.
// Entries are newest first (by release date); the newest KEEP_VERSIONS stay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const KEEP_VERSIONS = 20;
const [version, tag, channel, url, tarball, notesFile] = process.argv.slice(2);

if (!version || !tag || !url || !tarball || !['stable', 'experimental'].includes(channel)) {
  console.error('usage: update-manifest.js <version> <tag> <stable|experimental> <download-url> <tarball> [notes-file]');
  process.exit(64);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) { console.error(`not a semver version: ${version}`); process.exit(64); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const data = fs.readFileSync(tarball);
const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '';
const entry = {
  version,
  tag,
  channel,
  date: new Date().toISOString(),
  npm: `${pkg.name}@${version}`,
  node: pkg.engines?.node || null,
  url,
  sha256: crypto.createHash('sha256').update(data).digest('hex'),
  size: data.length,
  changelog: (channel === 'experimental' ? '[experimental] ' : '') + (notes || 'Release'),
};

const files = channel === 'stable'
  ? [['manifest.json', 'stable'], ['manifest-experimental.json', 'experimental']]
  : [['manifest-experimental.json', 'experimental']];

for (const [name, ch] of files) {
  const file = path.join(ROOT, name);
  const m = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const versions = [entry, ...(m.versions || []).filter((v) => v.version !== version)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, KEEP_VERSIONS);
  const out = {
    name: pkg.name,
    description: pkg.description,
    channel: ch,
    homepage: pkg.homepage || m.homepage || null,
    latest: versions.find((v) => v.channel === 'stable')?.version || null,
    ...(ch === 'experimental' ? { latestExperimental: versions[0]?.version || null } : {}),
    updated: entry.date,
    versions,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`${name}: added ${version} (${channel}) · ${versions.length} version(s)`);
}
