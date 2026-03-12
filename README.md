# Fatharr

A self-hosted AI chat assistant for your home server. Powered by Claude, it answers questions about your server, looks up live data (downloads, disk space, docker containers), and can run shell commands on the host — all from a clean web chat interface.

Built for non-technical users. Ask it anything: "what's downloading?", "are there any movies set for deletion?", "how do I request a movie?" — it looks it up and answers directly.

---

## How it works

The assistant uses tools backed by Claude's tool-use API:

- **`api(service, endpoint)`** — queries your services (Radarr, Sonarr, Plex, Overseerr, etc.) with credentials injected automatically. Claude never sees your API keys.
- **`bash(command)`** — runs shell commands on your Docker host via SSH, subject to a [tiered permission system](#tiered-permissions). Claude just provides the command; the SSH connection details come from your `.env`.
- **`runbook(name)`** — executes [pre-approved fix procedures](#runbooks) for common issues (e.g., restarting Plex, checking disk space).
- **`read_result(id)`** — reads or searches through large tool results. When `api` or `bash` returns a large response, it's saved to disk and Claude gets a summary with a result ID. This tool lets Claude paginate or grep through saved results without bloating the conversation context.

All credentials live in `.env` (git-ignored). `CLAUDE.md` contains only documentation — no secrets — so it's safe to commit and share publicly.

---

## Requirements

- Docker + Docker Compose
- An [Anthropic API key](https://console.anthropic.com)
- Optional: SSH access to your host for `docker ps`, logs, disk checks, etc.

---

## Quick Start

**1. Clone the repo**
```bash
git clone https://github.com/Rubes78/Fatharr.git
cd Fatharr
```

**2. Create your `.env` file**
```bash
cp .env.example .env
```
Edit `.env` and fill in your Anthropic API key and service credentials.

**3. (Optional) Set up SSH host access**

If you want the assistant to run live commands on your host, create a dedicated low-privilege user:

```bash
# On your host — create a dedicated user
sudo useradd -m -s /bin/bash assistant
sudo usermod -aG docker assistant  # allows container management without sudo

# Grant limited sudo for service management
echo 'assistant ALL=(root) NOPASSWD: /usr/bin/systemctl restart *, /usr/bin/systemctl start *, /usr/bin/systemctl stop *, /usr/bin/systemctl status *, /usr/bin/journalctl *' | sudo tee /etc/sudoers.d/assistant

# Generate a dedicated SSH key
ssh-keygen -t ed25519 -f ssh_key -N ""

# Authorize it for the assistant user
sudo mkdir -p /home/assistant/.ssh
sudo cp ssh_key.pub /home/assistant/.ssh/authorized_keys
sudo chown -R assistant:assistant /home/assistant/.ssh

# Create the backup directory
sudo mkdir -p /opt/fatharr-backups
sudo chown assistant:assistant /opt/fatharr-backups
```

If you skip SSH setup, the assistant still works — it just can't run host commands.

**4. Customize `CLAUDE.md`**

Edit `CLAUDE.md` to describe your server — services, URLs, and how-tos. The more detail you add, the better it answers. See the included template as a starting point.

> **Warning:** `CLAUDE.md` is sent to the Anthropic API as context with every chat message. **Never put passwords, API keys, or tokens in this file.** All credentials belong in `.env` — the tool layer injects them automatically and Claude never sees them.

**5. (Optional) Configure notifications**

Set `APPRISE_URLS` in `.env` to receive push notifications when the assistant takes action or encounters issues. Apprise supports [80+ notification services](https://github.com/caronc/apprise/wiki) — Pushover, Telegram, Discord, email, SMS, and more.

```env
APPRISE_URL=http://apprise:8000
APPRISE_URLS=pover://user@token
```

**6. Start it**
```bash
docker compose up -d
```

Open `http://localhost:3456` (or `http://yourserver.local:3456`).

On first run, you'll be guided through:
1. **Setup Wizard** — configure API key, SSH, services, and notifications via a web GUI
2. **Onboarding Chat** — Claude explores your server, discovers containers and services, and writes its own reference document (CLAUDE.md) based on what it finds

---

## Features

### Tiered Permissions

Bash commands are classified into three tiers, enforced in code (not just the prompt):

| Tier | Action | Examples |
|---|---|---|
| **Tier 1 — Auto** | Executes immediately | `docker ps`, `df -h`, `docker logs`, `systemctl status` |
| **Tier 2 — Confirm** | Explains in plain English, asks user to approve | `docker restart plex`, `systemctl restart sonarr` |
| **Tier 3 — Escalate** | Refuses, tells user to call/text their admin | `rm`, `dd`, `apt install`, config edits, user changes |

Tier 2 commands also:
- Back up relevant config files before executing
- Send an Apprise notification to the admin after executing

Tier 3 commands send a notification that the request was refused.

### Runbooks

Pre-approved fix procedures in YAML format. Drop them in the `runbooks/` directory — no rebuild needed.

Included runbooks:
- `restart-plex` — restart Plex when unresponsive
- `restart-container` — check container status
- `check-disk-space` — investigate disk usage

Example runbook:
```yaml
name: restart-plex
description: Restart Plex when it's unresponsive
steps:
  - type: check
    command: docker ps --filter name=plex --format '{{.Status}}'
    expect: Up
    on_fail: continue
  - type: action
    command: docker restart plex
  - type: wait
    seconds: 15
  - type: verify
    command: docker ps --filter name=plex --format '{{.Status}}'
    expect: Up
    success_message: Plex is back up! Give it a minute to load.
    failure_message: Plex didn't restart. Call/text {admin_name}.
notify_admin: true
```

### Config Backups

Before Tier 2 commands that modify state, the assistant automatically backs up relevant config files to `/opt/fatharr-backups/{timestamp}/{full/original/path}`.

Safety guardrails:
- Files > 1 GB prompt for approval
- Aggregate > 10 GB prompts for approval
- Checks available disk space before copying
- Skips media files automatically
- Backups older than 7 days are auto-purged

### Notifications (Apprise)

Push notifications to your phone/chat when:
- A Tier 2 command is executed ("Plex container was restarted")
- A Tier 3 command is refused ("User asked to rm something — refused")
- A health check triggers ("Disk usage at 92%")
- A runbook completes or fails

### Health Checks

Proactive monitoring that runs on a schedule (requires Apprise):
- **Disk space** — alerts when usage exceeds 90% (every 6 hours)
- **Container health** — alerts when any container is down (every 15 minutes)
- **Media disk** — alerts when media drive exceeds 85% (every 6 hours)

### Model Selector

The chat UI includes a model dropdown with user-friendly labels:

| Label | Model | Best for |
|---|---|---|
| **Cheap** | Haiku 4.5 | Quick questions, low cost |
| **Standard** | Sonnet 4.6 | Default — good balance of speed + capability |
| **Smart** | Opus 4.6 | Complex troubleshooting, deep analysis |

Selection persists across sessions. Onboarding uses Haiku by default (configurable via `ONBOARD_MODEL`).

### Settings Menu

A gear icon in the chat header provides access to:
- **Re-run onboarding** — have Claude re-explore the server and update CLAUDE.md
- **Setup wizard** — reconfigure SSH keys, API keys, and service connections

### Audit Log

Every tool invocation is logged to `/app/data/audit.jsonl` with timestamp, command, tier, and result. View recent entries at `GET /api/audit`.

---

## Configuration

### `.env`
All credentials and connection details go here. Never committed to git.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | *(required)* Your Anthropic API key |
| `CLAUDE_MODEL` | Claude model for chat (default: `claude-sonnet-4-6`) |
| `ONBOARD_MODEL` | Claude model for onboarding (default: `claude-haiku-4-5-20251001`) |
| `AUTH_USER` + `AUTH_PASS` | Optional basic auth for the web UI |
| `PORT` | UI port (default: `3456`) |
| `ADMIN_NAME` | Name shown in escalation messages (default: `your admin`) |
| `ADMIN_CONTACT` | Optional phone/contact shown in escalation messages |
| `SSH_HOST` | Host to SSH into (default: `host.docker.internal`) |
| `SSH_USER` | SSH username (default: `assistant`) |
| `SSH_KEY_PATH` | Path to SSH key inside container (default: `/app/ssh_key`) |
| `APPRISE_URL` | Apprise sidecar URL (default: `http://apprise:8000`) |
| `APPRISE_URLS` | Notification targets — see [Apprise wiki](https://github.com/caronc/apprise/wiki) |
| `RADARR_URL` + `RADARR_API_KEY` | Radarr base URL and API key |
| `SONARR_URL` + `SONARR_API_KEY` | Sonarr base URL and API key |
| `PLEX_URL` + `PLEX_TOKEN` | Plex base URL and token |
| `OVERSEERR_URL` + `OVERSEERR_API_KEY` | Overseerr base URL and API key |
| `SABNZBD_URL` + `SABNZBD_API_KEY` | SABnzbd base URL and API key |
| `QB_URL` + `QB_USER` + `QB_PASS` | qBittorrent URL and login credentials |
| `MAINTAINERR_URL` | Maintainerr base URL (no auth required) |
| `GLANCES_URL` | Glances system monitor base URL |
| `BACKUP_DIR` | Host path for config backups (default: `/opt/fatharr-backups`) |

### `CLAUDE.md`
The assistant's reference document. Edit it to describe your server — services, how-tos, troubleshooting. **Contains no credentials** — this file is sent to the Anthropic API as the system prompt, so never put secrets here. Changes take effect immediately (volume-mounted, no rebuild needed).

---

## File structure

```
fatharr/
├── Dockerfile           # node:22-alpine + curl, jq, openssh-client
├── docker-compose.yml   # ports, env_file, volume mounts, Apprise sidecar
├── entrypoint.sh        # first-run provisioning (copies defaults to data volume)
├── server.js            # Express backend, Anthropic streaming, tool loop
├── tools.js             # tiered bash + api + runbook tools
├── config.js            # persistent config store (config.json + env var fallback)
├── setup.js             # setup wizard API routes
├── onboard.js           # interactive onboarding chat (Claude explores server)
├── audit.js             # structured audit logging
├── notify.js            # Apprise notification integration
├── backup.js            # config file backup with safety guardrails
├── runbooks.js          # runbook engine (loads YAML definitions)
├── healthcheck.js       # scheduled proactive health monitoring
├── public/
│   ├── index.html       # Single-page chat UI
│   ├── setup.html       # Setup wizard (first-run config)
│   └── onboard.html     # Onboarding chat (Claude explores + writes CLAUDE.md)
├── runbooks/            # ← drop YAML runbooks here (volume-mounted)
│   ├── restart-plex.yml
│   ├── restart-container.yml
│   ├── check-disk-space.yml
│   └── clear-download-queue.yml
├── CLAUDE.md            # ← auto-populated during onboarding (no credentials!)
├── .env.example         # copy to .env, fill in credentials
└── ssh_key              # ← generated during setup wizard (git-ignored)
```

### Credential flow

```
.env (git-ignored)
  └── tools.js reads credentials at startup
        ├── api tool  — injects API key into every request automatically
        ├── bash tool — injects SSH host/user/key into every command
        └── runbook   — uses SSH internally for pre-approved steps
              └── Claude sees only results, never credentials
```

---

## Updating

```bash
docker compose build --no-cache && docker compose up -d
```

## Adding a new service

1. Add `SERVICE_URL` and `SERVICE_API_KEY` to `.env` and `.env.example`
2. Add the service entry to the `SERVICES` object in `tools.js`
3. Document the service and its useful endpoints in `CLAUDE.md`
4. Rebuild

## Adding a new runbook

1. Create a YAML file in `runbooks/` (see existing examples)
2. No rebuild needed — runbooks are volume-mounted and reloaded automatically
