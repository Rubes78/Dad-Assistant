/**
 * config.js — persistent configuration with env var fallback
 *
 * Reads config from /app/data/config.json (written by setup wizard).
 * Environment variables always take precedence over saved config.
 * This lets users configure via the setup wizard OR via env vars/compose.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || '/app/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let savedConfig = {};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('Could not load config.json:', err.message);
  }
}

function save(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Merge with existing config (don't lose keys not in this update)
    savedConfig = { ...savedConfig, ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(savedConfig, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Could not save config.json:', err.message);
    return false;
  }
}

/**
 * Get a config value. Env vars take precedence over saved config.
 * @param {string} key — env var name (e.g. 'ANTHROPIC_API_KEY')
 * @param {*} defaultValue — fallback if neither env nor config has it
 */
function get(key, defaultValue) {
  if (process.env[key]) return process.env[key];
  if (savedConfig[key] !== undefined && savedConfig[key] !== '') return savedConfig[key];
  return defaultValue;
}

/**
 * Check if the app has been configured (has an API key).
 */
function isConfigured() {
  return !!(get('ANTHROPIC_API_KEY') || get('OPENROUTER_API_KEY'));
}

/**
 * Get all current config (merged env + saved), with secrets masked.
 */
function getAll() {
  const keys = [
    'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDE_MODEL', 'PORT',
    'ADMIN_NAME', 'ADMIN_CONTACT',
    'SSH_HOST', 'SSH_USER', 'SSH_KEY_PATH',
    'APPRISE_URL', 'APPRISE_URLS',
    'RADARR_URL', 'RADARR_API_KEY',
    'SONARR_URL', 'SONARR_API_KEY',
    'PLEX_URL', 'PLEX_TOKEN',
    'OVERSEERR_URL', 'OVERSEERR_API_KEY',
    'SABNZBD_URL', 'SABNZBD_API_KEY',
    'MAINTAINERR_URL',
    'QB_URL', 'QB_USER', 'QB_PASS',
    'GLANCES_URL',
    'BACKUP_DIR',
    'AUTH_USER', 'AUTH_PASS',
  ];

  const SECRET_KEYS = [
    'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'RADARR_API_KEY', 'SONARR_API_KEY',
    'PLEX_TOKEN', 'OVERSEERR_API_KEY', 'SABNZBD_API_KEY',
    'QB_PASS', 'AUTH_PASS',
  ];

  const result = {};
  for (const key of keys) {
    const val = get(key);
    if (val !== undefined) {
      result[key] = SECRET_KEYS.includes(key) && val
        ? val.slice(0, 4) + '****'
        : val;
    } else {
      result[key] = '';
    }
  }
  return result;
}

/**
 * Get the raw (unmasked) saved config for re-editing in the wizard.
 */
function getSaved() {
  return { ...savedConfig };
}

// Load on startup
load();

module.exports = { get, save, load, isConfigured, getAll, getSaved };
