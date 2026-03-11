const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const MAX_HISTORY    = 40;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ── System prompt ──────────────────────────────────────────────────────────────
function loadSystemPrompt() {
  try { return fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8'); }
  catch { return 'You are a helpful assistant.'; }
}

// ── Session management ─────────────────────────────────────────────────────────
const sessions = new Map();

const SEED_MESSAGES = [
  { role: 'user',      content: 'What can you do?' },
  { role: 'assistant', content: "I have the full server reference loaded and live access via tools — I can check what's downloading, query any service API, run host commands, check disk space, and more. Just ask." },
];

function getOrCreateSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [...SEED_MESSAGES], lastActive: Date.now() });
  const s = sessions.get(id);
  s.lastActive = Date.now();
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastActive < cutoff) sessions.delete(id);
}, 30 * 60 * 1000);

// ── Meta-question short-circuit ────────────────────────────────────────────────
const META_PATTERNS = [
  /review.*server/i, /create.*claude\.?md/i, /make.*claude\.?md/i,
  /commit.*memory/i, /can you access/i,      /can you browse/i,
  /what can you (do|see|access)/i,           /don.t you have access/i,
];

const META_RESPONSE = `I have the full server reference loaded and live tool access. I can:

- **Check what's downloading** — query Radarr/Sonarr queues right now
- **See what's queued for deletion** — query Maintainerr collections
- **Check disk space** — run a live disk check
- **See recent Plex additions** — query the Plex library
- **Check pending requests** — query Overseerr
- **Run host commands** — docker ps, logs, system stats
- **Answer any how-to** — full service docs are loaded

What do you need?`;

// ── Routes ─────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

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
      const response = await client.messages.create({
        model:      MODEL,
        max_tokens: 2048,
        system:     loadSystemPrompt(),
        messages:   workingMessages,
        tools:      TOOL_DEFINITIONS,
      });

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
        // Show a status line — for api tool include service name; for bash show the command
        const label = block.name === 'api'
          ? `${block.input.service}${block.input.endpoint}`
          : block.input.command?.slice(0, 60) + (block.input.command?.length > 60 ? '…' : '');
        send({ status: `${block.name === 'api' ? '⚡' : '$'} ${label}` });

        console.log(`TOOL ${block.name}:`, JSON.stringify(block.input));
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }

      workingMessages.push({ role: 'user', content: toolResults });
    }

    if (fullResponse) session.messages.push({ role: 'assistant', content: fullResponse });
    send({ done: true });
  } catch (err) {
    console.error('API error:', err.message);
    send({ error: 'Something went wrong. Please try again.' });
  }

  res.end();
});

app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dad assistant running on port ${PORT}`));
