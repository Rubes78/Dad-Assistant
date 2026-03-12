/**
 * setup.js — first-run setup wizard routes
 *
 * Provides API endpoints for:
 *   - Checking setup status
 *   - Saving configuration
 *   - Generating SSH keys
 *   - Testing service connections
 */

const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const execAsync = promisify(exec);
const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || '/app/data';

// ── Status check ─────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const sshKeyExists = fs.existsSync(path.join(DATA_DIR, 'ssh_key')) || fs.existsSync('/app/ssh_key');
  res.json({
    configured: config.isConfigured(),
    sshKeyExists,
    config: config.getAll(),
  });
});

// ── Save configuration ──────────────────────────────────────────────
router.post('/save', (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Missing settings object' });
  }

  // Don't save masked values (the **** ones) — keep originals
  const saved = config.getSaved();
  const cleaned = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string' && value.includes('****')) {
      // Keep the original saved value
      if (saved[key]) cleaned[key] = saved[key];
    } else if (value !== '') {
      cleaned[key] = value;
    }
  }

  if (config.save(cleaned)) {
    res.json({ ok: true, message: 'Configuration saved. Restart the container to apply changes.' });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// ── Generate SSH key pair ───────────────────────────────────────────
router.post('/generate-ssh-key', async (req, res) => {
  const keyPath = path.join(DATA_DIR, 'ssh_key');
  const pubPath = `${keyPath}.pub`;

  // Don't overwrite existing key
  if (fs.existsSync(keyPath)) {
    const pubKey = fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8').trim() : '(public key file missing)';
    return res.json({
      ok: true,
      existed: true,
      publicKey: pubKey,
      message: 'SSH key already exists. Showing existing public key.',
    });
  }

  try {
    await execAsync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "fatharr@$(hostname)"`, { timeout: 10000 });

    // Symlink so the app finds it at /app/ssh_key
    if (!fs.existsSync('/app/ssh_key')) {
      fs.symlinkSync(keyPath, '/app/ssh_key');
    }

    const pubKey = fs.readFileSync(pubPath, 'utf8').trim();
    res.json({
      ok: true,
      existed: false,
      publicKey: pubKey,
      message: 'SSH key generated. Add the public key to your server.',
    });
  } catch (err) {
    res.status(500).json({ error: `SSH key generation failed: ${err.message}` });
  }
});

// ── Test SSH connection ─────────────────────────────────────────────
router.post('/test-ssh', async (req, res) => {
  const host = req.body.host || config.get('SSH_HOST', 'host.docker.internal');
  const user = req.body.user || config.get('SSH_USER', 'assistant');
  const keyPath = fs.existsSync(path.join(DATA_DIR, 'ssh_key'))
    ? path.join(DATA_DIR, 'ssh_key')
    : '/app/ssh_key';

  if (!fs.existsSync(keyPath)) {
    return res.json({ ok: false, error: 'No SSH key found. Generate one first.' });
  }

  try {
    const { stdout } = await execAsync(
      `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${user}@${host} "echo OK && hostname"`,
      { timeout: 15000 }
    );
    res.json({ ok: true, output: stdout.trim() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Test a service API connection ───────────────────────────────────
router.post('/test-service', async (req, res) => {
  const { url, apiKey, authType, authKey } = req.body;
  if (!url) return res.json({ ok: false, error: 'No URL provided' });

  try {
    const headers = {};
    let testUrl = url;

    if (apiKey) {
      if (authType === 'header') {
        headers[authKey || 'X-Api-Key'] = apiKey;
      } else if (authType === 'param') {
        const sep = testUrl.includes('?') ? '&' : '?';
        testUrl = `${testUrl}${sep}${authKey || 'apikey'}=${encodeURIComponent(apiKey)}`;
      }
    }

    const response = await fetch(testUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    res.json({
      ok: response.ok,
      status: response.status,
      message: response.ok ? 'Connection successful!' : `HTTP ${response.status}`,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
