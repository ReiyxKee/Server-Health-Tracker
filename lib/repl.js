'use strict';
// Interactive prompt: `sht` with no arguments. Slash commands, tab completion.
const readline = require('node:readline');
const C = require('./config');
const T = require('./term');
const { run, COMMANDS, snapshot, serviceState } = require('./commands');

function tokenize(line) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

async function header(baseOpts) {
  const cfg = C.loadConfig(baseOpts.config);
  const svc = serviceState();
  let state = null, source = '';
  try { ({ state, source } = await snapshot(cfg, {})); } catch { /* ignore */ }
  const icon = state ? { ok: T.green('✓ healthy'), warn: T.yellow('! warning'), crit: T.red('× critical') }[state.status] : '';
  console.log(`${T.bold('Server Health Tracker')} · ${state?.host || ''} · ${icon}`);
  const url = cfg.web === false ? 'web off' : `http://${cfg.host}:${cfg.port}`;
  const svcText = svc === 'not installed' ? T.yellow('service not installed (/install)') : svc === 'active' ? T.green(`service active · ${url}`) : T.yellow(`service ${svc} (/start)`);
  console.log(`${svcText}${source === 'local' && svc !== 'active' ? T.dim(' · showing a local snapshot') : ''}`);
  if (state) {
    const bad = Object.entries(state.checks).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k} ${v}`);
    if (bad.length) console.log(T.yellow(`attention: ${bad.join(', ')}`));
    const pins = T.renderPinned(state.services.pinned);
    console.log(pins ? `\n${T.bold('Pinned')}\n${pins}` : T.dim('\nnothing pinned yet — /pin 7001 Jellyfin'));
  }
  console.log(T.dim('\n/help for commands · /quit to exit'));
}

async function repl(baseOpts = {}) {
  await header(baseOpts);
  const names = Object.keys(COMMANDS).concat(['quit', 'exit', 'clear']);
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: T.cyan('sht› '), historySize: 200,
    completer: (line) => {
      const slash = line.startsWith('/') ? '/' : '';
      const word = line.replace(/^\//, '');
      if (word.includes(' ')) return [[], line];
      const hits = names.filter((n) => n.startsWith(word)).map((n) => slash + n);
      return [hits, line];
    },
  });
  let stopWatch = null;
  rl.prompt();
  rl.on('line', async (line) => {
    if (stopWatch) { const s = stopWatch; stopWatch = null; s(); return; }
    const tokens = tokenize(line.trim().replace(/^\//, ''));
    if (!tokens.length) return rl.prompt();
    const cmd = tokens[0];
    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') return rl.close();
    if (cmd === 'clear') { process.stdout.write('\x1b[H\x1b[2J'); return rl.prompt(); }
    rl.pause();
    try {
      await run(tokens, { interactive: true, baseOpts, onStop: (fn) => { stopWatch = fn; rl.resume(); } });
    } catch (e) { console.log(T.red(e.message)); }
    stopWatch = null;
    rl.resume();
    rl.prompt();
  });
  rl.on('SIGINT', () => { if (stopWatch) { const s = stopWatch; stopWatch = null; s(); } else rl.close(); });
  rl.on('close', () => process.exit(0));
}

module.exports = { repl, tokenize };
