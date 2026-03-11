const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MAX_HISTORY = 40;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ── Bash tool ──────────────────────────────────────────────────────────────────
const SSH_KEY_PATH = '/app/ssh_key';
const sshAvailable = fs.existsSync(SSH_KEY_PATH);

const TOOLS = [
  {
    name: 'bash',
    description: sshAvailable
      ? `Execute a shell command. curl and jq are available for API queries. To run commands on the host itself (docker ps, df, systemctl, files, etc.) use SSH:
  ssh -i /app/ssh_key -o StrictHostKeyChecking=no root@host.docker.internal "your command here"
For API queries you can use curl directly without SSH since you are already on the host network.`
      : `Execute a shell command. curl and jq are available for API queries against local network services. No SSH key is configured so host shell access is not available.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
      },
      required: ['command'],
    },
  },
];

async function runBash(command) {
  try {
    const { stdout, stderr } = await execAsync(command, {
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

// ── Session management ─────────────────────────────────────────────────────────
function loadSystemPrompt() {
  try { return fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8'); }
  catch { return 'You are a helpful assistant.'; }
}

const sessions = new Map();
const SEED_MESSAGES = [
  { role: 'user',      content: 'What can you do?' },
  { role: 'assistant', content: "I have the full McRubes server reference loaded and I can run shell commands — so I can query any API, check what's downloading, see what Maintainerr is set to delete, check disk space, run docker commands on the host, and more. Just ask and I'll look it up." },
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

const META_PATTERNS = [
  /review.*server/i, /create.*claude\.?md/i, /make.*claude\.?md/i,
  /commit.*memory/i, /can you access/i, /can you browse/i,
  /what can you (do|see|access)/i, /don.t you have access/i,
];

const META_RESPONSE = `I have the McRubes reference loaded and live shell access to the server. I can:

- **Check what's downloading** right now
- **See what Maintainerr has queued for deletion**
- **Check disk space**
- **Look up recent additions in Plex**
- **Check pending Overseerr requests**
- **Run docker commands** on the host
- **Answer any question** about how to use the server

What do you want to know?`;

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

  const sid = sessionId || crypto.randomUUID();
  const session = getOrCreateSession(sid);
  session.messages.push({ role: 'user', content: message.trim() });
  while (session.messages.length > MAX_HISTORY) session.messages.shift();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', sid);

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let workingMessages = [...session.messages];
  let fullResponse = '';

  try {
    for (let round = 0; round < 10; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: loadSystemPrompt(),
        messages: workingMessages,
        tools: TOOLS,
      });

      // Stream any text in this response
      const textContent = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      if (textContent) {
        fullResponse += textContent;
        send({ text: textContent });
      }

      if (response.stop_reason !== 'tool_use') break;

      // Execute bash tool calls
      workingMessages.push({ role: 'assistant', content: response.content });
      const toolResults = [];

      for (const block of response.content.filter(b => b.type === 'tool_use')) {
        const cmd = block.input.command || '';
        const label = cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd;
        send({ status: `$ ${label}` });

        const result = await runBash(cmd);
        console.log(`CMD: ${cmd}`);
        if (result.error) console.log(`ERR: ${result.error}`);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
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
