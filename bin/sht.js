#!/usr/bin/env node
'use strict';
// sht — Server Health Tracker. `sht` alone opens the interactive prompt.
const { run, parseArgs } = require('../lib/commands');
const T = require('../lib/term');

const argv = process.argv.slice(2);
const globals = parseArgs(argv);
const onlyGlobals = globals._.length === 0 && !globals.help && !globals.version && !globals.json;

(async () => {
  if (onlyGlobals && process.stdin.isTTY && process.stdout.isTTY) {
    // full-screen UI; --plain (or a tiny terminal) gives the line prompt instead
    const small = (process.stdout.columns || 80) < 70 || (process.stdout.rows || 24) < 18;
    if (globals.plain || small) return require('../lib/repl').repl({ config: globals.config });
    return require('../lib/tui').tui({ config: globals.config });
  }
  await run(argv, { baseOpts: { config: globals.config } });
})().catch((e) => { console.error(T.red(e.stack || e.message)); process.exit(1); });
