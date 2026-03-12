/**
 * healthcheck.js — scheduled proactive health monitoring
 *
 * Runs periodic checks on the host and services, sending Apprise
 * notifications when something looks wrong. Checks are defined
 * in healthchecks.yml (volume-mounted) or fall back to built-in defaults.
 */

const fs = require('fs');
const path = require('path');
const notify = require('./notify');
const audit = require('./audit');

const CHECKS_FILE = process.env.HEALTHCHECKS_FILE || '/app/healthchecks.yml';

// ── Built-in default checks ─────────────────────────────────────────────────
const DEFAULT_CHECKS = [
  {
    name: 'Disk space',
    intervalMs: 6 * 60 * 60 * 1000,  // every 6 hours
    type: 'bash',
    command: "df / --output=pcent | tail -1 | tr -d ' %'",
    alertIf: (output) => {
      const pct = parseInt(output, 10);
      return !isNaN(pct) && pct > 90;
    },
    message: (output) => `Disk usage is at ${output.trim()}% — consider cleaning up or expanding storage.`,
  },
  {
    name: 'Container health',
    intervalMs: 15 * 60 * 1000,  // every 15 minutes
    type: 'bash',
    command: "docker ps -a --format '{{.Names}} {{.Status}}' | grep -v 'Up' | grep -v 'NAMES' || true",
    alertIf: (output) => output.trim().length > 0,
    message: (output) => `These containers are not running:\n${output.trim()}`,
  },
  {
    name: 'Media disk space',
    intervalMs: 6 * 60 * 60 * 1000,  // every 6 hours
    type: 'bash',
    command: "df /Media --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || echo '0'",
    alertIf: (output) => {
      const pct = parseInt(output, 10);
      return !isNaN(pct) && pct > 85;
    },
    message: (output) => `Media drive is at ${output.trim()}% — check if Maintainerr has items queued for cleanup.`,
  },
];

// ── State tracking ───────────────────────────────────────────────────────────
const checkTimers = [];
let runSshFn = null;

/**
 * Initialize health checks with an SSH runner function.
 * @param {Function} runSsh — function to run SSH commands (from tools.js)
 */
function start(runSsh) {
  runSshFn = runSsh;

  if (!notify.enabled) {
    console.log('Health checks disabled (Apprise not configured)');
    return;
  }

  const checks = DEFAULT_CHECKS;
  console.log(`Starting ${checks.length} health checks`);

  for (const check of checks) {
    // Run once after a short startup delay, then on interval
    const timer = setTimeout(() => {
      runCheck(check);
      const interval = setInterval(() => runCheck(check), check.intervalMs);
      checkTimers.push(interval);
    }, 30000 + Math.random() * 30000); // stagger startup by 30-60s

    checkTimers.push(timer);
  }
}

/**
 * Run a single health check.
 */
async function runCheck(check) {
  if (!runSshFn) return;

  try {
    const result = await runSshFn(check.command, 15000);
    const output = result.stdout || '';

    if (check.alertIf(output)) {
      const message = check.message(output);
      console.log(`Health check alert [${check.name}]: ${message}`);
      audit.log({ tool: 'healthcheck', input: { name: check.name }, result: 'alert', message });
      notify.send(`🔍 ${check.name}`, message, { type: 'warning' });
    }
  } catch (err) {
    console.warn(`Health check [${check.name}] failed:`, err.message);
  }
}

/**
 * Stop all health check timers.
 */
function stop() {
  for (const timer of checkTimers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  checkTimers.length = 0;
}

/**
 * Run all checks immediately (for manual trigger).
 */
async function runAll() {
  const results = [];
  for (const check of DEFAULT_CHECKS) {
    try {
      const result = await runSshFn(check.command, 15000);
      const output = result.stdout || '';
      const alert = check.alertIf(output);
      results.push({
        name: check.name,
        status: alert ? 'alert' : 'ok',
        message: alert ? check.message(output) : 'OK',
        output: output.trim(),
      });
    } catch (err) {
      results.push({ name: check.name, status: 'error', message: err.message });
    }
  }
  return results;
}

module.exports = { start, stop, runAll };
