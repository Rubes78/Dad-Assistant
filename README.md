# Dad Assistant

A self-hosted AI chat assistant for your home server. Powered by Claude, it answers questions about your server, looks up live data (downloads, disk space, docker containers), and can run shell commands on the host — all from a clean web chat interface.

Built for non-technical users. Ask it anything: "what's downloading?", "are there any movies set for deletion?", "how do I request a movie?" — it looks it up and answers directly.

![Chat interface with dark purple theme]

---

## What it does

- Answers questions about your server from a customizable reference doc (`CLAUDE.md`)
- Queries live data via APIs (Radarr, Sonarr, Plex, Overseerr, etc.) using the Claude tool-use API
- Runs shell commands on the Docker host via SSH — `docker ps`, disk usage, logs, anything
- Converts file paths to clickable FileBrowser links automatically
- Streams responses with a typing indicator
- Remembers conversation context within a session

---

## Requirements

- Docker + Docker Compose
- An [Anthropic API key](https://console.anthropic.com) (Claude access required)
- Optional: SSH access to your host for running live commands

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
Edit `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-...
```

**3. Customize `CLAUDE.md`**

This is the assistant's brain. Edit it to describe your server — services, URLs, passwords, how-tos. The more detail you add, the better it answers. See the included template as a starting point.

**4. (Optional) Enable host shell access**

If you want the assistant to run live commands on your host (docker ps, disk usage, logs, etc.):

```bash
# Generate a dedicated SSH key
ssh-keygen -t ed25519 -f ssh_key -N ""

# Authorize it on your host
cat ssh_key.pub >> ~/.ssh/authorized_keys
```

If you skip this step, the assistant still works — it just can't run host commands.

**5. Start it**
```bash
docker compose up -d
```

Open `http://localhost:3456` (or `http://yourserver.local:3456` if running on a home server).

---

## Configuration

### `.env`
| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model to use |
| `PORT` | `3456` | Port to expose the UI on |

### `CLAUDE.md`
The system prompt loaded at every conversation. Edit this to:
- Describe your server's services, URLs, and passwords
- Add API credentials so Claude can query live data with `curl`
- Add troubleshooting steps for common problems

Changes take effect immediately — no rebuild needed (it's volume-mounted).

### `docker-compose.yml`
- `./CLAUDE.md` is mounted into the container — edit it anytime without rebuilding
- `./ssh_key` is mounted for host access — remove that line if you don't need it
- `host.docker.internal` resolves to the Docker host automatically — no hardcoded IPs

---

## How it works

The assistant uses Claude's [tool use API](https://docs.anthropic.com/en/docs/build-with-claude/tool-use). When a question needs live data, Claude calls a `bash` tool that runs shell commands inside the container. For host-level commands (docker, disk, logs), it SSHes to the host via `host.docker.internal`.

The conversation history is kept in memory per session (2-hour TTL). Sessions are identified by a UUID stored in the browser's `localStorage`.

---

## File structure

```
dad-assistant/
├── Dockerfile           # node:22-alpine + curl, jq, openssh-client
├── docker-compose.yml   # ports, env, volume mounts
├── server.js            # Express backend, Anthropic streaming, bash tool
├── public/
│   └── index.html       # Single-page chat UI
├── CLAUDE.md            # ← customize this for your server
├── .env.example         # copy to .env, add your API key
└── ssh_key              # ← generate this for host shell access (git-ignored)
```

---

## Updating

```bash
docker compose build --no-cache && docker compose up -d
```
