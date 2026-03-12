/**
 * audit.js — structured audit logging
 *
 * Logs every tool invocation to an append-only JSONL file.
 * Provides an API for reading recent entries.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || '/app/data';
const LOG_FILE  = path.join(DATA_DIR, 'audit.jsonl');
const MAX_SIZE  = 10 * 1024 * 1024; // 10 MB — rotate when exceeded
const MAX_AGE   = 30 * 24 * 60 * 60 * 1000; // 30 days

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Log an audit entry.
 * @param {Object} entry — { tool, input, tier?, result, error? }
 */
function log(entry) {
  try {
    ensureDir();
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.warn('Audit log write failed:', err.message);
  }
}

/**
 * Read recent audit entries.
 * @param {number} limit — max entries to return (default 100)
 * @returns {Array} — most recent entries, newest first
 */
function readRecent(limit = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    console.warn('Audit log read failed:', err.message);
    return [];
  }
}

/**
 * Rotate the log file if it exceeds MAX_SIZE.
 * Keeps only the most recent half of entries.
 */
function rotate() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_SIZE) return;

    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n', 'utf8');
    console.log(`Audit log rotated: kept ${keep.length} of ${lines.length} entries`);
  } catch (err) {
    console.warn('Audit log rotation failed:', err.message);
  }
}

/**
 * Prune entries older than MAX_AGE.
 */
function prune() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoff = new Date(Date.now() - MAX_AGE).toISOString();
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const kept = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        return entry.timestamp >= cutoff;
      } catch { return false; }
    });
    if (kept.length < lines.length) {
      fs.writeFileSync(LOG_FILE, kept.join('\n') + '\n', 'utf8');
      console.log(`Audit log pruned: removed ${lines.length - kept.length} old entries`);
    }
  } catch (err) {
    console.warn('Audit log prune failed:', err.message);
  }
}

// Run rotation and pruning on startup and every 6 hours
rotate();
prune();
setInterval(() => { rotate(); prune(); }, 6 * 60 * 60 * 1000);

module.exports = { log, readRecent };
