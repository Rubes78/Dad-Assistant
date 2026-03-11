/**
 * tools.js — credential-aware tool server
 *
 * Reads all secrets from environment variables.
 * Exposes two tools to Claude: bash and api.
 * Claude never sees any credentials — it just names a service or provides a command.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// ── SSH config (from env) ──────────────────────────────────────────────────────
const SSH_HOST = process.env.SSH_HOST     || 'host.docker.internal';
const SSH_USER = process.env.SSH_USER     || 'root';
const SSH_KEY  = process.env.SSH_KEY_PATH || '/app/ssh_key';
const sshAvailable = fs.existsSync(SSH_KEY);

// ── Service registry (from env) ────────────────────────────────────────────────
// auth: 'header' = X-Api-Key header, 'param' = query param key name, null = no auth
const SERVICES = {
  radarr:      { url: process.env.RADARR_URL,      key: process.env.RADARR_API_KEY,      auth: 'header',         authKey: 'X-Api-Key'       },
  sonarr:      { url: process.env.SONARR_URL,      key: process.env.SONARR_API_KEY,      auth: 'header',         authKey: 'X-Api-Key'       },
  plex:        { url: process.env.PLEX_URL,         key: process.env.PLEX_TOKEN,          auth: 'param',          authKey: 'X-Plex-Token'    },
  overseerr:   { url: process.env.OVERSEERR_URL,   key: process.env.OVERSEERR_API_KEY,   auth: 'header',         authKey: 'X-Api-Key'       },
  sabnzbd:     { url: process.env.SABNZBD_URL,     key: process.env.SABNZBD_API_KEY,     auth: 'param',          authKey: 'apikey'          },
  maintainerr: { url: process.env.MAINTAINERR_URL, key: null,                            auth: null                                         },
};

const availableServices = Object.entries(SERVICES)
  .filter(([, s]) => s.url)
  .map(([name]) => name);

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
Provide the service name and the endpoint path.
Examples:
  service="radarr"      endpoint="/queue?pageSize=20"
  service="sonarr"      endpoint="/queue?pageSize=20"
  service="plex"        endpoint="/library/sections"
  service="plex"        endpoint="/library/sections/1/recentlyAdded?X-Plex-Container-Size=10"
  service="overseerr"   endpoint="/request?take=20&sort=added"
  service="maintainerr" endpoint="/collections"
  service="sabnzbd"     endpoint="?mode=queue&output=json"`,
    input_schema: {
      type: 'object',
      properties: {
        service:  { type: 'string', enum: availableServices, description: 'Which service to query.' },
        endpoint: { type: 'string', description: 'API path + query string, e.g. /queue or /library/sections' },
      },
      required: ['service', 'endpoint'],
    },
  },
];

// ── Tool executors ─────────────────────────────────────────────────────────────
async function executeBash(command) {
  let fullCommand;

  if (sshAvailable) {
    // Base64-encode the command so any quoting/special chars are safe over SSH
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
  const svc = SERVICES[service];
  if (!svc)      return { error: `Unknown service: ${service}. Available: ${availableServices.join(', ')}` };
  if (!svc.url)  return { error: `${service} is not configured (missing URL env var).` };

  // Inject auth without exposing it to the model
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
