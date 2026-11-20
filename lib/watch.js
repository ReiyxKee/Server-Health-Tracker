'use strict';
// `sht watch`: simple scrolling-free live view (the full UI is plain `sht`).
const T = require('./term');
const { openSource } = require('./source');

async function watch(cfg, ctx = {}) {
  const hint = ctx.interactive ? 'Enter to stop' : 'Ctrl+C to quit';
  const src = await openSource(cfg, {
    local: ctx.opts?.local,
    onUpdate: (s) => {
      if (!s.state) return;
      process.stdout.write('\x1b[H\x1b[2J');
      console.log(T.renderStatus(s.state, ctx.opts || {}));
      console.log(T.dim(`\n${s.kind === 'daemon' ? `daemon http://${cfg.host}:${cfg.port}` : s.kind} · ${new Date(s.state.time).toLocaleTimeString()} · ${hint}`));
    },
  });
  if (ctx.interactive) await new Promise((r) => ctx.onStop?.(() => { src.stop(); r(); }));
}

module.exports = { watch };
