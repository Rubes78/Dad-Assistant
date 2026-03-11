/**
 * tools.js — credential-aware tool server
 *
 * Reads all secrets from environment variables.
 * Exposes two tools to Claude: bash and api.
 * Claude never sees any credentials — it just names a service or provides a command.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execAsync = promisify(exec);

// ── SSH config (from env) ──────────────────────────────────────────────────────
const SSH_HOST = process.env.SSH_HOST     || 'host.docker.internal';
const SSH_USER = process.env.SSH_USER     || 'root';
const SSH_KEY  = process.env.SSH_KEY_PATH || '/app/ssh_key';
const sshAvailable = fs.existsSync(SSH_KEY);

// ── Bash blocklist — refuse commands that could cause irreversible damage ──────
const BLOCKED_PATTERNS = [
  /\brm\s+.*-[a-z]*r[a-z]*f\b/i,   // rm -rf variants
  /\brm\s+.*-[a-z]*f[a-z]*r\b/i,
  /\bmkfs\b/,                        // format a filesystem
  /\bdd\s+.*of=\/dev\//,            // write directly to a block device
  />\s*\/dev\/(sd|nvme|hd|vd)/,     // redirect to a disk device
  /\b:\(\)\s*\{.*\}/,               // fork bomb
  /\bshred\b/,                       // secure-delete
  /\bwipefs\b/,                      // wipe filesystem signatures
];

function checkBashBlocklist(command) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: command matches a destructive pattern (${pattern}). If you genuinely need this, text Daniel.`;
    }
  }
  return null;
}

// ── Service registry (from env) ────────────────────────────────────────────────
// auth types: 'header' = X-Api-Key header | 'param' = query param | 'cookie' = session cookie | null = none
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

// ── qBittorrent session cookie cache ───────────────────────────────────────────
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
      qbCookie = cookie.split(';')[0]; // extract SID=... part
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

  // If session expired, re-login once
  if (res.status === 403) {
    qbCookie = await qbLogin();
    if (!qbCookie) return { error: 'qBittorrent session expired and re-login failed.' };
    res = await fetch(url, { headers: { Cookie: qbCookie }, signal: AbortSignal.timeout(10000) });
  }

  if (!res.ok) return { error: `HTTP ${res.status} from qbittorrent${endpoint}` };
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { text }; }
}

// ── Tool definitions (sent to Claude — no credentials) ─────────────────────────
const TOOL_DEFINITIONS = [
  {
    name: 'bash',
    description: sshAvailable
      ? `Run a shell command on the McRubes host. Use for: docker ps, df, container logs, file browsing, system checks. Just provide the command — SSH connection is handled automatically.`
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
    description: `Query a McRubes service API. Authentication is handled automatically — do not add credentials to the endpoint.
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
];

// ── Tool executors ─────────────────────────────────────────────────────────────
async function executeBash(command) {
  const blocked = checkBashBlocklist(command);
  if (blocked) return { error: blocked };

  let fullCommand;
  if (sshAvailable) {
    const b64 = Buffer.from(command).toString('base64');
    fullCommand = `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_USER}@${SSH_HOST} "echo ${b64} | base64 -d | bash"`;
  } else {
    fullCommand = command;
  }

  try {
    const { stdout, stderr } = await execAsync(fullCommand, {
      timeout: 30000,
      maxBuffer: 512 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() || undefined };
  } catch (err) {
    return {
      error: err.message,
      stdout: err.stdout?.trim() || undefined,
      stderr: err.stderr?.trim() || undefined,
    };
  }
}

async function executeApi(service, endpoint) {
  if (service === 'qbittorrent') return executeQbApi(endpoint);

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
    if (!res.ok) return { error: `HTTP ${res.status} from ${service}${endpoint}` };
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { text }; }
  } catch (err) {
    return { error: err.message };
  }
}

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'bash': return await executeBash(input.command);
      case 'api':  return await executeApi(input.service, input.endpoint);
      default:     return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, sshAvailable, availableServices };
