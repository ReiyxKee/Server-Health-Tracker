# Server Health Tracker (`sht`)

Lightweight health tracking for Linux servers: CPU, memory, swap, load,
temperatures, storage and mounts, network, systemd services, processes, and
**automatically detected listening ports** with the process and unit behind each one.

- Zero dependencies. Reads `/proc` and `/sys` directly.
- `sht` opens a **tabbed full-screen terminal UI** (Overview · Ports · Services ·
  Alerts · Processes) with a notification button, mouse support, sortable
  columns and a `/slash` command line.
- An optional **daemon + web dashboard** does detection in the background. The
  page has the same tabs (Overview · Ports · Services · Alerts), with a
  notification button, sortable columns and bookmarkable `#tab` URLs. It
  receives a single event stream and never polls. Processes stay in the
  terminal UI so the daemon never has to sample them.
- You can **label** anything (`/alias 7001 Jellyfin`) and **pin** what matters
  (`/pin 7001`). Pinned items sit on top and alert when they go down.
- Per-service CPU and memory come from systemd's cgroup accounting, and Docker
  containers are included. The daemon reads them only while a dashboard or
  terminal UI is connected. Sorting happens in the browser or terminal, never on
  the server.
- Measured footprint of the daemon: about 0.3% of one core idle and 0.4% with a
  viewer, about 65 MB RSS. It is capped by systemd at `MemoryMax=96M` and `CPUQuota=10%`.

## Install

```sh
npm install -g server-health-tracker
sht                      # full-screen UI (no daemon needed)
```

Daemon + web dashboard (default: everything):

```sh
sudo "$(which node)" "$(which sht)" install                 # localhost:7002
sudo "$(which node)" "$(which sht)" install --host 10.8.0.1 --port 7002 --allow-from 10.8.0.0/24
```

`sudo sht install` also works if `node` is on root's PATH. With nvm it usually isn't.

| Option | Effect |
|---|---|
| `--port N` | port for the dashboard/API (default 7002) |
| `--host H` | bind address: `127.0.0.1`, your VPN/LAN IP, or `0.0.0.0` |
| `--web` / `--no-web` | serve the HTML dashboard, or the API only (default `--web`) |
| `--allow-from CIDR` | add a UFW rule for that source (repeatable). If omitted and UFW is active, you are asked |
| `--no-firewall` | never touch the firewall |
| `--cli-only` | only install the `sht` command, no service |
| `--config FILE` | install FILE as `/etc/sht/config.json` |

The installer copies the app **and the node binary** to `/opt/sht`, so the
service doesn't depend on npm, nvm or the source checkout. It installs:

- `/usr/local/bin/sht` (the command)
- `/etc/sht/config.json` (the config)
- `sht.service` (enabled at boot)

The service runs as the unprivileged system user `sht` with a read-only view of
the system, except `/etc/sht`, where it saves pins and aliases made in the web
dashboard. Its only capabilities are `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH`,
which it needs to see which process owns a socket. If it binds to a VPN address before the
tunnel is up, it retries until the address exists.

Firewall rules that sht adds are recorded in `/etc/sht/firewall.json`.
Changing the port moves them and `sht uninstall` removes them. Only UFW is managed.

## Terminal UI

`sht` with no arguments (`sht --plain` for a simple line prompt):

```
 ! 2   1 Overview  2 Ports  3 Services  4 Alerts  5 Processes     myhost ● warning · service 10.8.0.1:7002 · 9:05:31 AM
─ Services  40 running · 0 failed · 6.1% CPU in services ────────────────────────────────────────────────
    NAME / ALIAS              CPU%  MEMORY↓ UNIT                         STATE        DESCRIPTION
▲✓  Nextcloud database          1.3     200M snap.nextcloud.mysql         running      Service for snap …
 ✓  Jellyfin server             9.8     1.1G docker:jellyfin (container)  running      Docker container …
 ✓  pm2 apps                    2.2     123M pm2-reiyx                    running      PM2 process manager
```

| Tab | Shows |
|---|---|
| 1 Overview | CPU (per core and history), memory, swap, load, temperatures, network per interface, storage and mounts |
| 2 Ports | every listening port with alias, process, PID, unit and bind address. Pinned first, ephemeral shown (`e` toggles) |
| 3 Services | running services and containers with CPU% and memory. Pinned and failed first |
| 4 Alerts | current warnings and errors, then the history of status changes |
| 5 Processes | top-like process list with alias, unit and owned ports (sampled only while the tab is open) |

- The **notification button** at the top left counts current issues (green/yellow/red). A `•` marks new
  history. Clicking it, or pressing `a`, opens Alerts.
- **Sorting:** click a column header (click again to reverse), or press `s` (next column) / `r` (reverse).
- **Keys:** `1`-`5` or `←`/`→` switch tabs · `↑`/`↓`/`PgUp`/`PgDn`/wheel scroll · `/` command line · `?` help · `q` quits.
- The clock ticks every second, independent of the sampling rate.
- Mouse support is on, so hold Shift to select text in most terminals.

## Commands

Every command works as `/cmd` inside the UI and as `sht cmd` in a shell.
Anything that needs root re-runs itself through `sudo`.

| Command | |
|---|---|
| `status` `watch` `pinned` `ports` `services` | views (`--json`, `--no-ephemeral`, `--local`) |
| `alias <target> <name…>` / `unalias <target>` | label a port, unit or process |
| `pin <target> [alias…]` / `unpin <target>` | show on top; critical when down |
| `sort <column> [asc\|desc]` | sort the current table (UI only) |
| `web on\|off` | HTML dashboard on/off |
| `port <n>` / `host <addr>` | where the daemon listens (offers a firewall rule) |
| `poll <seconds>` | sampling rate |
| `set <key> <value>` / `unset <key>` | any setting, e.g. `set thresholds.disk 80,90` |
| `mount add\|remove <path>` | mounts that must be present |
| `install` `uninstall` `start` `stop` `restart` `enable` `disable` `logs` | service control |
| `config` | file in use and merged values |

**Targets:** `7001` (tcp), `6969/udp`, `unit:nginx`, `proc:jellyfin`, or a bare
name (resolved to a unit if one exists, otherwise a process).

The daemon watches its config file, so aliases, pins, poll rate, thresholds,
`web`, and even `port`/`host` apply live without a restart.

## Configuration

`/etc/sht/config.json` (or `~/.config/sht/config.json` without an install,
`--config FILE`, or `$SHT_CONFIG`) is merged over
[`config.default.json`](config.default.json):

```json
{
  "host": "127.0.0.1",
  "port": 7002,
  "web": true,
  "sampleMs": 2000,
  "expectedMounts": ["/", "/mnt/media"],
  "aliases": { "tcp/7001": "Jellyfin", "unit:snap.docker.dockerd": "Docker", "proc:jellyfin": "Jellyfin server" },
  "pinned": ["tcp/7001", "unit:nginx", "proc:jellyfin"],
  "ignorePorts": [631],
  "serviceUsage": true,
  "serviceUsageMs": 5000,
  "thresholds": { "disk": [80, 90] }
}
```

- Every listening port is detected automatically. A port that was listening and
  disappears is flagged `stopped listening`. A pinned port that is down is critical.
- `thresholds` are `[warn, crit]` in %, except temp (°C) and load (per core, 5-minute average).
- `expectedMounts` are critical when not mounted.

## Pinning & renaming from the web

Viewing the dashboard needs no sign-in. **Changing** pins and aliases needs an
account:

```sh
sht user add reiyx        # asks for a password (min. 8 characters); sudo when installed
sht user list
sht user passwd reiyx     # change the password, which also signs that user out everywhere
sht user remove reiyx     # remove the account and end its sessions
```

In the dashboard, click **🔒 Sign in to edit**. Each row in Ports and Services
then has 📌 (pin/unpin) and ✎ (rename). Edits go into the same config file the
CLI uses, so `sht`, alerts and every browser see them immediately.

- Passwords are stored only as salted scrypt hashes in `users.json` next to the
  config. That file is mode 0600 and readable only by the service.
- A session lasts 12 hours in an `HttpOnly`, `SameSite=Strict` cookie. Requests
  from other websites are refused.
- Ten failed sign-ins from one address lock it out for a minute.
- The `sht` command itself never asks for these passwords. In the terminal, Linux
  permissions (sudo) decide who may change things.

## API

| Endpoint | |
|---|---|
| `GET /api/events` | SSE: `init` (state + history), `sample`, `disks`, `services`, `alert` |
| `GET /api/health` | latest snapshot |
| `GET /api/history` | `{t, cpu, mem, rx, tx}` ring buffer |
| `GET /api/alerts` | status changes since start |
| `GET /api/session` | `{user, accounts}`: who is signed in |
| `POST /api/login` / `POST /api/logout` | `{user, password}` sets or clears the session cookie |
| `POST /api/edit` | `{action: pin\|unpin\|alias\|unalias, key, alias?}`, needs a signed-in session |

## Development

```sh
node bin/sht.js serve --config reigen.config.json   # dev daemon (config not published)
node bin/sht.js --config reigen.config.json         # UI against it
npm test
npm pack --dry-run
```

## Releases & channels

| Channel | How you get it | Who it's for |
|---|---|---|
| **Stable** (default) | `npm i -g server-health-tracker` · GitHub "Latest release" · `manifest.json` | everyone |
| **Experimental** | `npm i -g server-health-tracker@experimental` · GitHub pre-releases · `manifest-experimental.json` | early testers, at their own risk |
| **Dev build** | Actions → Build → a run → Artifacts (kept 7 days), then `npm i -g ./server-health-tracker-*-dev.N.tgz` | development |

Releases are made by pushing a tag. `.github/workflows/release.yml` tests, packs,
creates the GitHub Release, publishes to npm (when enabled) and updates the
manifests:

```sh
git tag v0.2.0       && git push origin v0.2.0         # stable
git tag v0.3.0-exp.1 && git push origin v0.3.0-exp.1   # experimental (-beta.N / -dev.N work too)
```

In npm/semver order `0.3.0-exp.1` comes *before* `0.3.0`, so name experiments
after the version they lead up to. The manifests list the 20 newest releases,
each with download URL, sha256 and changelog.

### Publishing to npm (one-time setup)

1. Create an npmjs.com account with two-factor auth, then `npm login`.
2. Publish the first version by hand (trusted publishing can only be set up on an
   existing package): `npm publish --access public`.
3. On npmjs.com, go to the package → **Settings** → **Trusted publishing** → GitHub
   Actions. Enter your GitHub user, the repository name and workflow `release.yml`.
4. In the GitHub repo, go to **Settings** → **Secrets and variables** → **Actions** →
   **Variables** and add `NPM_PUBLISH` = `true`.

From then on every tag publishes automatically with provenance, and no token is
stored anywhere. Alternative: add a granular npm token as the `NPM_TOKEN` secret
instead of steps 3 and 4. Granular tokens expire, so you'd need to renew it.

## License

[MIT](LICENSE): free and open source. Use, modify and share it.
