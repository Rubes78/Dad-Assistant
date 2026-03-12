/**
 * tools.js — credential-aware tool server with tiered permissions
 *
 * Reads all secrets from environment variables.
 * Exposes tools to Claude: bash, api, and runbook.
 * Claude never sees any credentials — it just names a service or provides a command.
 *
 * Bash commands are classified into three tiers:
 *   Tier 1 (auto)     — read-only commands, execute immediately
 *   Tier 2 (confirm)  — service management, require user confirmation + notify admin
 *   Tier 3 (escalate) — destructive/risky, refused with escalation message
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const audit = require('./audit');
const backup = require('./backup');
const notify = require('./notify');
const runbooks = require('./runbooks');

const execAsync = promisify(exec);

// ── Result file storage ──────────────────────────────────────────────────────
const RESULTS_DIR = '/app/data/results';
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
let resultCounter = 0;

function saveResult(content) {
  const str = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  // Small results don't need a file
  if (str.length < 2000) return null;
  resultCounter++;
  const id = `r${Date.now()}-${resultCounter}`;
  const filePath = path.join(RESULTS_DIR, `${id}.txt`);
  fs.writeFileSync(filePath, str, 'utf8');
  const lines = str.split('\n').length;
  // Clean up old result files (keep last 50)
  try {
    const files = fs.readdirSync(RESULTS_DIR).sort();
    while (files.length > 50) {
      fs.unlinkSync(path.join(RESULTS_DIR, files.shift()));
    }
  } catch {}
  return { id, path: filePath, lines, bytes: str.length };
}

function readResultFile(id, { offset = 1, limit = 100, grep } = {}) {
  const filePath = path.join(RESULTS_DIR, `${id}.txt`);
  if (!fs.existsSync(filePath)) return { error: `Result file "${id}" not found.` };
  const content = fs.readFileSync(filePath, 'utf8');
  const allLines = content.split('\n');

  if (grep) {
    const pattern = new RegExp(grep, 'i');
    const matches = [];
    for (let i = 0; i < allLines.length; i++) {
      if (pattern.test(allLines[i])) {
        matches.push({ line: i + 1, text: allLines[i] });
        if (matches.length >= limit) break;
      }
    }
    return { total_lines: allLines.length, matches, query: grep };
  }

  const start = Math.max(0, offset - 1);
  const slice = allLines.slice(start, start + limit);
  return {
    total_lines: allLines.length,
    showing: `${start + 1}-${start + slice.length}`,
    content: slice.join('\n'),
  };
}

// ── Config (from env) ────────────────────────────────────────────────────────
const SSH_HOST = process.env.SSH_HOST     || 'host.docker.internal';
const SSH_USER = process.env.SSH_USER     || 'assistant';
const SSH_KEY  = process.env.SSH_KEY_PATH || '/app/ssh_key';
const sshAvailable = fs.existsSync(SSH_KEY);

const ADMIN_NAME    = process.env.ADMIN_NAME    || 'your admin';
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '';

// ── Tiered permission system ─────────────────────────────────────────────────
// Tier 1: read-only, observational — auto-execute
const TIER_1_PATTERNS = [
  /^docker\s+(ps|logs|stats|inspect|images|volume\s+ls|network\s+ls)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
  /^(df|du|free|uptime|lsblk|lscpu|lsmem)\b/,
  /^(uname|hostnamectl|hostname)\b/,
  /^cat\s+\/(etc\/(os-release|hostname|hosts|resolv\.conf|timezone))\b/,
  /^(top|htop|vmstat|iostat|iotop)\s+-[bn]/,  // non-interactive only
  /^systemctl\s+status\b/,
  /^journalctl\s+/,
  /^(ping|dig|nslookup|traceroute|curl\s+-[sS]|wget\s+-q)/,
  /^(ls|find|wc|head|tail|grep|awk|sed\s+-n|sort|uniq|cut)\b/,
  /^(date|whoami|id|env|printenv)\b/,
  /^docker\s+exec\s+\S+\s+(ls|cat|head|tail|grep|df|du|free|ps)\b/,
];

// Tier 2: service management — require confirmation, then execute + notify
const TIER_2_PATTERNS = [
  /^docker\s+(restart|start|stop)\s+/,
  /^docker\s+compose\s+(up|down|restart|pull|build)\b/,
  /^systemctl\s+(restart|start|stop|reload|enable|disable)\s+/,
  /^(apt|apt-get)\s+(update|list)\b/,
  /^docker\s+exec\s+\S+\s+(apt|pip|npm)\s/,
];

// Tier 2 commands that should trigger config backup before execution
const BACKUP_TRIGGERS = [
  /^docker\s+compose\s+(up|down|build)\b/,
  /^systemctl\s+(restart|stop|disable)\s+/,
];

function classifyCommand(command) {
  const trimmed = command.trim();

  for (const pattern of TIER_1_PATTERNS) {
    if (pattern.test(trimmed)) return { tier: 1, label: 'auto' };
  }

  for (const pattern of TIER_2_PATTERNS) {
    if (pattern.test(trimmed)) return { tier: 2, label: 'confirm' };
  }

  // Everything else is Tier 3 — default deny
  return { tier: 3, label: 'escalate' };
}

// ── Service registry (from env) ──────────────────────────────────────────────
const SERVICES = {
  radarr:       { url: process.env.RADARR_URL,      key: process.env.RADARR_API_KEY,      auth: 'header', authKey: 'X-Api-Key'    },
  sonarr:       { url: process.env.SONARR_URL,      key: process.env.SONARR_API_KEY,      auth: 'header', authKey: 'X-Api-Key'    },
  plex:         { url: process.env.PLEX_URL,         key: process.env.PLEX_TOKEN,          auth: 'param',  authKey: 'X-Plex-Token' },
  overseerr:    { url: process.env.OVERSEERR_URL,   key: process.env.OVERSEERR_API_KEY,   auth: 'header', authKey: 'X-Api-Key'    },
  sabnzbd:      { url: process.env.SABNZBD_URL,     key: process.env.SABNZBD_API_KEY,     auth: 'param',  authKey: 'apikey'       },
  maintainerr:  { url: process.env.MAINTAINERR_URL, key: null,                            auth: null                              },
  qbittorrent:  { url: process.env.QB_URL,           key: null,                            auth: 'cookie',
                  user: process.env.QB_USER, pass: process.env.QB_PASS                                                            },
  glances:      { url: process.env.GLANCES_URL,     key: null,                            auth: null                              },
};

const availableServices = Object.entries(SERVICES)
  .filter(([, s]) => s.url)
  .map(([name]) => name);

// ── qBittorrent session cookie cache ─────────────────────────────────────────
let qbCookie = null;

async function qbLogin() {
  const svc = SERVICES.qbittorrent;
  if (!svc.url || !svc.user) return null;
  try {
    const res = await fetch(`${svc.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(svc.user)}&password=${encodeURIComponent(svc.pass || '')}`,
      signal: AbortSignal.timeout(8000),
    });
    const cookie = res.headers.get('set-cookie');
    if (cookie) {
      qbCookie = cookie.split(';')[0];
      return qbCookie;
    }
  } catch {}
  return null;
}

async function executeQbApi(endpoint) {
  const svc = SERVICES.qbittorrent;
  if (!svc.url) return { error: 'qBittorrent URL not configured.' };

  if (!qbCookie) qbCookie = await qbLogin();
  if (!qbCookie) return { error: 'Could not authenticate with qBittorrent.' };

  const url = `${svc.url}${endpoint}`;
  let res = await fetch(url, { headers: { Cookie: qbCookie }, signal: AbortSignal.timeout(10000) });

  if (res.status === 403) {
    qbCookie = await qbLogin();
    if (!qbCookie) return { error: 'qBittorrent session expired and re-login failed.' };
    res = await fetch(url, { headers: { Cookie: qbCookie }, signal: AbortSignal.timeout(10000) });
  }

  if (!res.ok) return { error: `HTTP ${res.status} from qbittorrent${endpoint}` };
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { text }; }
}

// ── Available runbook names for tool description ─────────────────────────────
const availableRunbooks = runbooks.listRunbooks();

// ── Tool definitions (sent to Claude — no credentials) ───────────────────────
const TOOL_DEFINITIONS = [
  {
    name: 'bash',
    description: sshAvailable
      ? `Run a shell command on the host via SSH. Commands are subject to a tiered permission system:
- Tier 1 (auto): Read-only commands run immediately (docker ps, df, logs, systemctl status, etc.)
- Tier 2 (confirm): Service changes return a confirmation prompt — you MUST explain the action in plain English and wait for user approval before proceeding (docker restart, systemctl restart, etc.)
- Tier 3 (escalate): Destructive commands are refused — tell the user to call/text ${ADMIN_NAME} with a plain-English description.
SSH connection is handled automatically. Just provide the command.`
      : `Run a shell command in the container. curl and jq are available.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'api',
    description: `Query a service API. Authentication is handled automatically — do not add credentials to the endpoint.
Available services: ${availableServices.join(', ')}
Examples:
  service="radarr"       endpoint="/queue?pageSize=20"
  service="sonarr"       endpoint="/queue?pageSize=20"
  service="plex"         endpoint="/library/sections"
  service="plex"         endpoint="/library/sections/1/recentlyAdded?X-Plex-Container-Size=10"
  service="overseerr"    endpoint="/request?take=20&sort=added"
  service="maintainerr"  endpoint="/collections"
  service="sabnzbd"      endpoint="?mode=queue&output=json"
  service="qbittorrent"  endpoint="/api/v2/torrents/info"
  service="glances"      endpoint="/api/4/cpu"  (also: /api/4/mem /api/4/disk /api/4/all)`,
    input_schema: {
      type: 'object',
      properties: {
        service:  { type: 'string', enum: availableServices, description: 'Which service to query.' },
        endpoint: { type: 'string', description: 'API path + query string.' },
      },
      required: ['service', 'endpoint'],
    },
  },
  {
    name: 'read_result',
    description: `Read or search through a previously saved tool result. When a tool returns a large response, it's saved to a file and you get a summary with a result ID. Use this tool to read specific lines or grep through those saved results.
Examples:
  id="r1234-1"                         — read first 100 lines
  id="r1234-1" offset=50 limit=20      — read lines 50-69
  id="r1234-1" grep="matrix"           — search for lines matching "matrix" (case-insensitive regex)`,
    input_schema: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: 'The result ID returned by a previous tool call.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based). Default: 1.' },
        limit:  { type: 'number', description: 'Maximum number of lines to return. Default: 100.' },
        grep:   { type: 'string', description: 'Regex pattern to search for (case-insensitive). Returns matching lines with line numbers.' },
      },
      required: ['id'],
    },
  },
  ...(availableRunbooks.length > 0 ? [{
    name: 'runbook',
    description: `Execute a pre-approved fix procedure. These are admin-defined routines for common issues.
Runbooks bypass the normal bash tier restrictions because the admin has pre-approved every step.
Prefer runbooks over ad-hoc bash commands when one matches the issue.
Available runbooks: ${availableRunbooks.map(r => `${r.name} — ${r.description}`).join('; ')}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: availableRunbooks.map(r => r.name), description: 'Which runbook to execute.' },
      },
      required: ['name'],
    },
  }] : []),
];

// ── SSH command execution ────────────────────────────────────────────────────
async function runSshCommand(command, timeout = 30000) {
  let fullCommand;
  if (sshAvailable) {
    const b64 = Buffer.from(command).toString('base64');
    fullCommand = `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_USER}@${SSH_HOST} "echo ${b64} | base64 -d | bash"`;
  } else {
    fullCommand = command;
  }

  const { stdout, stderr } = await execAsync(fullCommand, {
    timeout,
    maxBuffer: 512 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() || undefined };
}

// ── Tool executors ───────────────────────────────────────────────────────────
async function executeBash(command) {
  const classification = classifyCommand(command);

  // Tier 3: refuse and escalate
  if (classification.tier === 3) {
    const result = {
      error: 'escalate_to_admin',
      tier: 3,
      command,
      message: `This command requires admin approval. Call/text ${ADMIN_NAME}${ADMIN_CONTACT ? ` (${ADMIN_CONTACT})` : ''} and tell them: "The assistant wants to run: ${command}". They'll know what to do.`,
    };
    audit.log({ tool: 'bash', input: { command }, tier: 3, result: 'refused' });
    notify.send(`⛔ Tier 3 command refused`, `Command: ${command}\nUser was told to contact admin.`);
    return result;
  }

  // Tier 2: return confirmation prompt (don't execute yet)
  if (classification.tier === 2) {
    const result = {
      needs_confirmation: true,
      tier: 2,
      command,
      message: `This command needs your approval before I run it. Please explain to the user what this does in plain English, what could go wrong, and say: "If you're not sure, call/text ${ADMIN_NAME} and tell them: '[one-sentence summary]'. Otherwise, say 'go ahead' and I'll run it."`,
    };
    audit.log({ tool: 'bash', input: { command }, tier: 2, result: 'awaiting_confirmation' });
    return result;
  }

  // Tier 1: auto-execute
  try {
    const result = await runSshCommand(command);
    audit.log({ tool: 'bash', input: { command }, tier: 1, result: 'success' });
    return result;
  } catch (err) {
    audit.log({ tool: 'bash', input: { command }, tier: 1, result: 'error', error: err.message });
    return {
      error: err.message,
      stdout: err.stdout?.trim() || undefined,
      stderr: err.stderr?.trim() || undefined,
    };
  }
}

async function executeBashConfirmed(command) {
  // Called when user confirms a Tier 2 command
  const classification = classifyCommand(command);
  if (classification.tier !== 2) {
    return { error: 'This command does not require confirmation.' };
  }

  // Check if backup is needed before executing
  const needsBackup = BACKUP_TRIGGERS.some(p => p.test(command.trim()));
  if (needsBackup) {
    try {
      const backupResult = await backup.backupBeforeChange(command, runSshCommand);
      if (backupResult.error) {
        console.warn('Pre-change backup warning:', backupResult.error);
        // Don't block execution on backup failure, but log it
      }
    } catch (err) {
      console.warn('Pre-change backup failed:', err.message);
    }
  }

  try {
    const result = await runSshCommand(command);
    audit.log({ tool: 'bash', input: { command }, tier: 2, result: 'executed_after_confirmation' });
    notify.send(
      `✅ Tier 2 command executed`,
      `Command: ${command}\nResult: ${result.stdout?.slice(0, 200) || 'OK'}`
    );
    return result;
  } catch (err) {
    audit.log({ tool: 'bash', input: { command }, tier: 2, result: 'error', error: err.message });
    notify.send(`❌ Tier 2 command failed`, `Command: ${command}\nError: ${err.message}`);
    return {
      error: err.message,
      stdout: err.stdout?.trim() || undefined,
      stderr: err.stderr?.trim() || undefined,
    };
  }
}

async function executeApi(service, endpoint) {
  if (service === 'qbittorrent') {
    const result = await executeQbApi(endpoint);
    audit.log({ tool: 'api', input: { service, endpoint }, result: result.error ? 'error' : 'success' });
    return result;
  }

  const svc = SERVICES[service];
  if (!svc)     return { error: `Unknown service: ${service}. Available: ${availableServices.join(', ')}` };
  if (!svc.url) return { error: `${service} is not configured (missing URL env var).` };

  let url = `${svc.url}${endpoint}`;
  const headers = {};

  if (svc.key) {
    if (svc.auth === 'header') {
      headers[svc.authKey] = svc.key;
    } else if (svc.auth === 'param') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${svc.authKey}=${encodeURIComponent(svc.key)}`;
    }
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      audit.log({ tool: 'api', input: { service, endpoint }, result: 'error', error: `HTTP ${res.status}` });
      return { error: `HTTP ${res.status} from ${service}${endpoint}` };
    }
    const text = await res.text();
    audit.log({ tool: 'api', input: { service, endpoint }, result: 'success' });
    try { return JSON.parse(text); } catch { return { text }; }
  } catch (err) {
    audit.log({ tool: 'api', input: { service, endpoint }, result: 'error', error: err.message });
    return { error: err.message };
  }
}

async function executeRunbook(name) {
  audit.log({ tool: 'runbook', input: { name }, result: 'started' });
  const result = await runbooks.execute(name, runSshCommand);
  audit.log({ tool: 'runbook', input: { name }, result: result.error ? 'error' : 'success' });

  if (result.notify !== false) {
    const emoji = result.error ? '❌' : '🔧';
    notify.send(
      `${emoji} Runbook: ${name}`,
      result.summary || JSON.stringify(result).slice(0, 300)
    );
  }

  return result;
}

function wrapLargeResult(result) {
  const saved = saveResult(result);
  if (!saved) return result; // small enough, return inline

  // Build a summary for Claude instead of the full payload
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  const summary = { _saved: true, result_id: saved.id, lines: saved.lines, bytes: saved.bytes };

  // Add a preview: first few items if array, or first few lines
  if (Array.isArray(result)) {
    summary.total_items = result.length;
    summary.preview = result.slice(0, 3);
    summary._hint = `Use read_result(id="${saved.id}") to browse all ${result.length} items, or read_result(id="${saved.id}", grep="search term") to find specific entries.`;
  } else {
    summary.preview = str.slice(0, 500);
    summary._hint = `Use read_result(id="${saved.id}") to read the full output, or read_result(id="${saved.id}", grep="pattern") to search it.`;
  }
  return summary;
}

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'bash':           return wrapLargeResult(await executeBash(input.command));
      case 'bash_confirmed': return wrapLargeResult(await executeBashConfirmed(input.command));
      case 'api':            return wrapLargeResult(await executeApi(input.service, input.endpoint));
      case 'runbook':        return wrapLargeResult(await executeRunbook(input.name));
      case 'read_result':    return readResultFile(input.id, { offset: input.offset, limit: input.limit, grep: input.grep });
      default:               return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, sshAvailable, availableServices, runSshCommand, classifyCommand };
