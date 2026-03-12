#!/bin/bash
# entrypoint.sh — provision default files on first run
#
# Copies baked-in defaults to the persistent data volume if they don't
# already exist. This lets users deploy with just a data volume mount
# and get working defaults, while preserving any customizations they make.

DATA_DIR="/app/data"

# ── CLAUDE.md ─────────────────────────────────────────────────────────
# If no custom CLAUDE.md is mounted or present in data, copy the default
if [ ! -f "$DATA_DIR/CLAUDE.md" ]; then
  echo "First run: copying default CLAUDE.md to $DATA_DIR/"
  cp /app/defaults/CLAUDE.md "$DATA_DIR/CLAUDE.md"
fi

# Symlink so the app always reads from the data volume copy
# (unless a direct volume mount overrides /app/CLAUDE.md)
if [ ! -e /app/CLAUDE.md ] || [ /app/CLAUDE.md -ef /app/defaults/CLAUDE.md ]; then
  ln -sf "$DATA_DIR/CLAUDE.md" /app/CLAUDE.md
fi

# ── Runbooks ──────────────────────────────────────────────────────────
if [ ! -d "$DATA_DIR/runbooks" ] || [ -z "$(ls -A $DATA_DIR/runbooks 2>/dev/null)" ]; then
  echo "First run: copying default runbooks to $DATA_DIR/runbooks/"
  mkdir -p "$DATA_DIR/runbooks"
  cp /app/defaults/runbooks/*.yml "$DATA_DIR/runbooks/" 2>/dev/null || true
fi

# Symlink runbooks dir if it's still pointing at the empty built-in
if [ ! -e /app/runbooks ] || [ "$(readlink -f /app/runbooks)" = "/app/runbooks" ]; then
  rm -rf /app/runbooks
  ln -sf "$DATA_DIR/runbooks" /app/runbooks
fi

# ── SSH key ───────────────────────────────────────────────────────────
# If a key exists in the data volume but not at the expected path, link it
if [ -f "$DATA_DIR/ssh_key" ] && [ ! -f /app/ssh_key ]; then
  ln -sf "$DATA_DIR/ssh_key" /app/ssh_key
fi

# ── Config (setup wizard output) ─────────────────────────────────────
# If config.json exists in data, export its values as env vars
# (env vars from docker/compose take precedence)
if [ -f "$DATA_DIR/config.json" ]; then
  echo "Loading saved configuration from $DATA_DIR/config.json"
fi

echo "Fatharr starting..."
exec node server.js
