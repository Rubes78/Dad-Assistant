const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const basicAuth  = require('express-basic-auth');

const config = require('./config');
const { TOOL_DEFINITIONS, executeTool, runSshCommand, sshAvailable } = require('./tools');
const audit = require('./audit');
const healthcheck = require('./healthcheck');
const backup = require('./backup');
const setupRouter = require('./setup');
const onboardRouter = require('./onboard');

// ── Startup validation ─────────────────────────────────────────────────────────
if (!config.isConfigured()) {
  console.warn('WARN: No API key configured. Setup wizard will be shown at startup.');
  console.warn('Visit the web UI to complete initial setup.');
}

const OPTIONAL_ENV = ['RADARR_URL', 'SONARR_URL', 'PLEX_URL', 'OVERSEERR_URL', 'QB_URL', 'GLANCES_URL'];
const unconfigured = OPTIONAL_ENV.filter(k => !config.get(k));
if (unconfigured.length) {
  console.warn(`WARN: Optional services not configured: ${unconfigured.join(', ')}`);
}

// ── App setup ──────────────────────────────────────────────────────────────────
const app = express();

// Basic auth — only if AUTH_USER + AUTH_PASS are set in .env
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  app.use(basicAuth({
    users: { [process.env.AUTH_USER]: process.env.AUTH_PASS },
    challenge: true,
    realm: 'Fatharr',
  }));
  console.log(`Basic auth enabled for user: ${process.env.AUTH_USER}`);
}

// Rate limiting — 20 requests per minute per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a minute.' },
}));

app.use(express.json());

// Setup wizard routes (always available, even before config)
app.use('/api/setup', setupRouter);
app.use('/api/onboard', onboardRouter);

// Serve setup wizard and onboarding pages
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/onboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'onboard.html')));

// Redirect to setup wizard if not configured, or to onboarding if not onboarded
app.use((req, res, next) => {
  const staticPaths = ['/setup', '/onboard', '/api/setup', '/api/onboard'];
  const isStatic = staticPaths.some(p => req.path === p || req.path.startsWith(p + '/'));
  const isAsset = req.path.endsWith('.css') || req.path.endsWith('.js') || req.path.endsWith('.ico');
  if (isStatic || isAsset) return next();

  if (!config.isConfigured()) {
    return res.redirect('/setup');
  }

  const saved = config.getSaved();
  if (!saved._onboarded) {
    return res.redirect('/onboard');
  }

  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: config.get('ANTHROPIC_API_KEY', '') });
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];

const MAX_HISTORY    = 40;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TOOL_RESULT_CHARS = 30000; // ~8k tokens — prevents blowing context

function truncateToolResult(str) {
  if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
  // Try to parse as JSON array and truncate items
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      const truncated = parsed.slice(0, 20);
      return JSON.stringify({
        items: truncated,
        _truncated: true,
        _totalCount: parsed.length,
        _showing: truncated.length,
        _note: `Response too large (${parsed.length} items). Showing first 20. Use more specific queries (e.g. filters, smaller page sizes) to narrow results.`,
      });
    }
  } catch {}
  // Fallback: hard truncate with notice
  return str.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[TRUNCATED — response was ' + str.length + ' chars. Use more specific queries to narrow results.]';
}

// ── Session persistence ────────────────────────────────────────────────────────
const DATA_DIR     = '/app/data';
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const sessions     = new Map();
let   saveTimer    = null;

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw  = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now  = Date.now();
      let loaded = 0;
      for (const [id, session] of Object.entries(raw)) {
        if (now - session.lastActive < SESSION_TTL_MS) {
          sessions.set(id, session);
          loaded++;
        }
      }
      if (loaded) console.log(`Loaded ${loaded} sessions from disk`);
    }
  } catch (err) {
    console.warn('Could not load sessions:', err.message);
  }
}

function saveSessions() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [id, s] of sessions) obj[id] = s;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch (err) {
    console.warn('Could not save sessions:', err.message);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessions, 2000);
}

loadSessions();

// Prune expired sessions every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastActive < cutoff) sessions.delete(id);
  scheduleSave();
}, 30 * 60 * 1000);

// ── System prompt ──────────────────────────────────────────────────────────────
function loadSystemPrompt() {
  try { return fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8'); }
  catch { return 'You are a helpful assistant.'; }
}

// ── Session management ─────────────────────────────────────────────────────────
const SEED_MESSAGES = [
  { role: 'user',      content: 'What can you do?' },
  { role: 'assistant', content: "I have the full server reference loaded and live access via tools — I can check what's downloading, query any service API, run host commands, check disk space, and more. Just ask." },
];

function getOrCreateSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [...SEED_MESSAGES], lastActive: Date.now() });
  const s    = sessions.get(id);
  s.lastActive = Date.now();
  return s;
}

// ── Meta-question short-circuit ────────────────────────────────────────────────
const META_PATTERNS = [
  /review.*server/i, /create.*claude\.?md/i, /make.*claude\.?md/i,
  /commit.*memory/i, /can you access/i,      /can you browse/i,
  /what can you (do|see|access)/i,           /don.t you have access/i,
];

const META_RESPONSE = `I have the full server reference loaded and live tool access. I can:

- **Check what's downloading** — query Radarr/Sonarr/qBittorrent queues right now
- **See what's queued for deletion** — query Maintainerr collections
- **Check disk space and system resources** — run a live check
- **See recent Plex additions** — query the Plex library
- **Check pending requests** — query Overseerr
- **Run host commands** — docker ps, logs, system stats
- **Run pre-approved fixes** — restart services, check common issues
- **Answer any how-to** — full service docs are loaded

What do you need?`;

// ── Routes ─────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, model: requestedModel } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });
  const model = ALLOWED_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_MODEL;

  if (META_PATTERNS.some(p => p.test(message))) {
    const sid = sessionId || crypto.randomUUID();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-Id', sid);
    res.write(`data: ${JSON.stringify({ text: META_RESPONSE })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const sid     = sessionId || crypto.randomUUID();
  const session = getOrCreateSession(sid);
  session.messages.push({ role: 'user', content: message.trim() });
  while (session.messages.length > MAX_HISTORY) session.messages.shift();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', sid);

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let workingMessages = [...session.messages];
  let fullResponse    = '';

  try {
    for (let round = 0; round < 10; round++) {
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.messages.create({
            model:      model,
            max_tokens: 2048,
            system:     loadSystemPrompt(),
            messages:   workingMessages,
            tools:      TOOL_DEFINITIONS,
          });
          break;
        } catch (apiErr) {
          if (apiErr.status === 429 && attempt < 2) {
            const wait = (attempt + 1) * 15;
            send({ status: `Rate limited — waiting ${wait}s...` });
            await new Promise(r => setTimeout(r, wait * 1000));
            continue;
          }
          throw apiErr;
        }
      }

      const textContent = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      if (textContent) {
        fullResponse += textContent;
        send({ text: textContent });
      }

      if (response.stop_reason !== 'tool_use') break;

      workingMessages.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const block of response.content.filter(b => b.type === 'tool_use')) {
        let label, icon;
        if (block.name === 'api') {
          icon = '⚡'; label = `${block.input.service}${block.input.endpoint}`;
        } else if (block.name === 'runbook') {
          icon = '🔧'; label = block.input.name;
        } else {
          icon = '$'; label = block.input.command?.slice(0, 60) + (block.input.command?.length > 60 ? '…' : '');
        }
        send({ status: `${icon} ${label}` });

        console.log(`TOOL ${block.name}:`, JSON.stringify(block.input));
        const result = await executeTool(block.name, block.input);
        const resultStr = truncateToolResult(JSON.stringify(result));
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultStr });
      }

      workingMessages.push({ role: 'user', content: toolResults });
    }

    if (fullResponse) {
      session.messages.push({ role: 'assistant', content: fullResponse });
      scheduleSave();
    }
    send({ done: true });
  } catch (err) {
    console.error('API error:', err.status, err.message);
    const msg = err.status === 429
      ? 'Rate limited — please wait a minute and try again.'
      : 'Something went wrong. Please try again.';
    send({ error: msg });
  }

  res.end();
});

app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    sessions.delete(sessionId);
    scheduleSave();
  }
  res.json({ ok: true });
});

// ── Audit log endpoint ──────────────────────────────────────────────────────
app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(audit.readRecent(limit));
});

// Health check endpoint (used by Docker HEALTHCHECK)
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fatharr running on port ${PORT}`);

  // Start scheduled health checks (after a brief delay for SSH to be ready)
  if (sshAvailable) {
    setTimeout(() => {
      healthcheck.start(runSshCommand);
      // Schedule backup cleanup daily
      setInterval(async () => {
        try { await backup.cleanupOldBackups(runSshCommand); } catch {}
      }, 24 * 60 * 60 * 1000);
    }, 10000);
  }
});
