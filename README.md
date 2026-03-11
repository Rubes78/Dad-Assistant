# Dad Assistant

A self-hosted AI chat assistant for your home server. Powered by Claude, it answers questions about your server, looks up live data (downloads, disk space, docker containers), and can run shell commands on the host — all from a clean web chat interface.

Built for non-technical users. Ask it anything: "what's downloading?", "are there any movies set for deletion?", "how do I request a movie?" — it looks it up and answers directly.

---

## How it works

The assistant uses two tools backed by Claude's tool-use API:

- **`api(service, endpoint)`** — queries your services (Radarr, Sonarr, Plex, Overseerr, etc.) with credentials injected automatically. Claude never sees your API keys.
- **`bash(command)`** — runs shell commands on your Docker host via SSH. Claude just provides the command; the SSH connection details come from your `.env`.

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
git clone https://github.com/Rubes78/Dad-Assistant.git
cd Dad-Assistant
```

**2. Create your `.env` file**
```bash
cp .env.example .env
```
Edit `.env` and fill in your Anthropic API key and service credentials.

**3. (Optional) Enable host shell access**

If you want the assistant to run live commands on your host:
```bash
# Generate a dedicated SSH key
ssh-keygen -t ed25519 -f ssh_key -N ""

# Authorize it on your host
cat ssh_key.pub >> ~/.ssh/authorized_keys
```
If you skip this, the assistant still works — it just can't run host commands.

**4. Customize `CLAUDE.md`**

Edit `CLAUDE.md` to describe your server — services, URLs, passwords, how-tos. The more detail you add, the better it answers. See the included template as a starting point. This file contains no credentials.

**5. Start it**
```bash
docker compose up -d
```

Open `http://localhost:3456` (or `http://yourserver.local:3456`).

---

## Configuration

### `.env`
All credentials and connection details go here. Never committed to git.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | *(required)* Your Anthropic API key |
| `CLAUDE_MODEL` | Claude model (default: `claude-sonnet-4-6`) |
| `PORT` | UI port (default: `3456`) |
| `SSH_HOST` | Host to SSH into (default: `host.docker.internal`) |
| `SSH_USER` | SSH username (default: `root`) |
| `SSH_KEY_PATH` | Path to SSH key inside container (default: `/app/ssh_key`) |
| `RADARR_URL` + `RADARR_API_KEY` | Radarr base URL and API key |
| `SONARR_URL` + `SONARR_API_KEY` | Sonarr base URL and API key |
| `PLEX_URL` + `PLEX_TOKEN` | Plex base URL and token |
| `OVERSEERR_URL` + `OVERSEERR_API_KEY` | Overseerr base URL and API key |
| `SABNZBD_URL` + `SABNZBD_API_KEY` | SABnzbd base URL and API key |
| `MAINTAINERR_URL` | Maintainerr base URL (no auth required) |

### `CLAUDE.md`
The assistant's reference document. Edit it to describe your server — services, how-tos, troubleshooting. Contains no credentials. Changes take effect immediately (volume-mounted, no rebuild needed).

The `api` and `bash` tools are described here so Claude knows how to use them. Service credentials are never mentioned — they're injected by `tools.js` from environment variables.

---

## File structure

```
dad-assistant/
├── Dockerfile           # node:22-alpine + curl, jq, openssh-client
├── docker-compose.yml   # ports, env_file, volume mounts
├── server.js            # Express backend, Anthropic streaming, tool loop
├── tools.js             # bash + api tools — reads credentials from env
├── public/
│   └── index.html       # Single-page chat UI
├── CLAUDE.md            # ← customize for your server (no credentials)
├── .env.example         # copy to .env, fill in credentials
└── ssh_key              # ← generate this for host shell access (git-ignored)
```

### Credential flow

```
.env (git-ignored)
  └── tools.js reads credentials at startup
        ├── api tool  — injects API key into every request automatically
        └── bash tool — injects SSH host/user/key into every command
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
