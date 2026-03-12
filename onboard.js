/**
 * onboard.js — interactive onboarding chat
 *
 * After the setup wizard configures SSH + API keys, this module provides
 * a guided chat where Claude explores the server, asks the user questions,
 * and populates CLAUDE.md with real information about the environment.
 *
 * Provides:
 *   - POST /chat     — streaming chat with onboarding system prompt
 *   - POST /complete — marks onboarding as done
 *   - POST /update-claudemd — tool endpoint for Claude to write to CLAUDE.md
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { TOOL_DEFINITIONS, executeTool, sshAvailable, runSshCommand } = require('./tools');
const audit = require('./audit');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CLAUDE_MD_PATH = path.join(DATA_DIR, 'CLAUDE.md');
const MAX_TOOL_RESULT_CHARS = 30000;

function truncateToolResult(str) {
  if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      const truncated = parsed.slice(0, 20);
      return JSON.stringify({
        items: truncated, _truncated: true, _totalCount: parsed.length, _showing: truncated.length,
        _note: `Response too large (${parsed.length} items). Showing first 20.`,
      });
    }
  } catch {}
  return str.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[TRUNCATED — response was ' + str.length + ' chars.]';
}

// ── Onboarding session (single session, not per-user) ───────────────────────
let onboardSession = { messages: [], lastActive: Date.now() };

// ── CLAUDE.md update tool ───────────────────────────────────────────────────
// This tool is only available during onboarding — lets Claude write sections
// to its own reference document.

const ONBOARD_TOOLS = [
  ...TOOL_DEFINITIONS,
  {
    name: 'update_claudemd',
    description: `Update a section of CLAUDE.md — your own reference document. Use this to save what you discover about the server during onboarding.

How to use:
- "section" is a markdown heading (e.g., "Identity", "Services", "Storage", "Troubleshooting")
- "content" is the markdown content for that section (do NOT include the heading — it's added automatically)
- If the section already exists, its content is replaced. Otherwise, it's appended.
- You can call this multiple times to build out different sections.

Write information that will help you assist the user later: hostnames, service URLs, disk layout, container names, common issues, user preferences.`,
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section heading (e.g., "Identity", "Services", "Storage", "Troubleshooting")',
        },
        content: {
          type: 'string',
          description: 'Markdown content for this section (without the heading)',
        },
      },
      required: ['section', 'content'],
    },
  },
];

// ── Update CLAUDE.md section ────────────────────────────────────────────────
function updateClaudeMdSection(section, content) {
  let md;
  try {
    md = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  } catch {
    // If CLAUDE.md doesn't exist yet, start from the template header
    md = fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8');
  }

  const heading = `## ${section}`;
  const headingRegex = new RegExp(
    `(^|\\n)## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n[\\s\\S]*?(?=\\n## |$)`,
    'm'
  );

  if (headingRegex.test(md)) {
    // Replace existing section
    md = md.replace(headingRegex, `$1${heading}\n${content.trim()}\n`);
  } else {
    // Append new section before the end
    md = md.trimEnd() + `\n\n${heading}\n${content.trim()}\n`;
  }

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_MD_PATH, md, 'utf8');

  // Also update the symlink target if it exists
  const appClaudeMd = path.join(__dirname, 'CLAUDE.md');
  if (fs.lstatSync(appClaudeMd).isSymbolicLink()) {
    // It's already a symlink to the data dir — the write above covers it
  }

  return { ok: true, section, message: `Updated "${section}" section in CLAUDE.md` };
}

// ── Tool executor (wraps the main one + adds update_claudemd) ───────────────
async function executeOnboardTool(name, input) {
  if (name === 'update_claudemd') {
    const result = updateClaudeMdSection(input.section, input.content);
    audit.log({ tool: 'update_claudemd', input, result: 'success' });
    return result;
  }
  return executeTool(name, input);
}

// ── Onboarding system prompt ────────────────────────────────────────────────
const ADMIN_NAME = config.get('ADMIN_NAME', 'your admin');

function getOnboardingPrompt() {
  const hasSSH = sshAvailable;
  return `You are Fatharr, a home server assistant, and this is your first-run onboarding session. Your goal is to explore this server, learn about it, and build your own reference document (CLAUDE.md) with what you discover.

## Your Mission
Have a friendly, conversational onboarding chat with the user. You should:

1. **Introduce yourself** — explain that you're going to explore the server and learn about it so you can help effectively going forward.

2. **Explore the server** using your tools:
   - Run \`hostname\`, \`hostnamectl\`, \`uname -a\` to learn the system identity
   - Run \`docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'\` to see running containers
   - Run \`df -h\` and \`lsblk\` to understand disk layout
   - Run \`ls /etc/systemd/system/*.service\` or \`systemctl list-units --type=service --state=running\` to find services
   - Check for common media paths (\`ls /Media\`, \`ls /data\`, \`ls /mnt\`, etc.)
   - Test which service APIs are available using the \`api\` tool

3. **Ask the user questions** to fill in what you can't discover automatically:
   - What do they call this server? (friendly name)
   - Who are the main users? (just dad? whole family?)
   - Any services or features they use most?
   - Any known quirks or common issues?
   - What should you call the admin when suggesting they call for help?

4. **Save everything to CLAUDE.md** using the \`update_claudemd\` tool. Build out these sections:
   - **Identity** — hostname, OS, purpose, friendly name
   - **Dashboard** — homepage URL if one exists
   - **Services** — each discovered service with its URL, what it does, and basic how-to for a non-technical user
   - **Storage** — disk layout, media paths, important directories
   - **Troubleshooting** — common issues and fixes based on what you find

5. **Be conversational** — don't just dump a wall of commands. Explore a bit, share what you find, ask follow-up questions, then save. Make the user feel like they're setting things up together with you.

## Important Notes
- You have ${hasSSH ? 'SSH access to the host' : 'NO SSH access (it may not be configured yet — you can still explore within the container)'}.
- Keep CLAUDE.md written for a non-technical audience — this is what you'll reference when helping the user's dad (or other family members).
- Write service how-tos in plain language: "Go to [URL], click Request, search for the movie."
- The admin contact name is "${ADMIN_NAME}" — use this in troubleshooting entries.
- When you're done exploring and have saved everything, tell the user they can click "Finish" to start using the assistant.
- Do NOT put any credentials, API keys, or passwords in CLAUDE.md — ever.`;
}

// ── Chat endpoint ───────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

  onboardSession.messages.push({ role: 'user', content: message.trim() });
  onboardSession.lastActive = Date.now();

  // Keep conversation manageable
  while (onboardSession.messages.length > 60) onboardSession.messages.shift();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const client = new Anthropic({ apiKey: config.get('ANTHROPIC_API_KEY', '') });
  const MODEL = process.env.ONBOARD_MODEL || 'claude-haiku-4-5-20251001';

  let workingMessages = [...onboardSession.messages];
  let fullResponse = '';

  try {
    for (let round = 0; round < 15; round++) {
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.messages.create({
            model: MODEL,
            max_tokens: 4096,
            system: getOnboardingPrompt(),
            messages: workingMessages,
            tools: ONBOARD_TOOLS,
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
        if (block.name === 'update_claudemd') {
          icon = '📝'; label = `Saving "${block.input.section}" to CLAUDE.md`;
        } else if (block.name === 'api') {
          icon = '⚡'; label = `${block.input.service}${block.input.endpoint}`;
        } else if (block.name === 'bash') {
          icon = '$'; label = block.input.command?.slice(0, 60) + (block.input.command?.length > 60 ? '…' : '');
        } else {
          icon = '🔧'; label = block.name;
        }
        send({ status: `${icon} ${label}` });

        console.log(`ONBOARD TOOL ${block.name}:`, JSON.stringify(block.input));
        const result = await executeOnboardTool(block.name, block.input);
        const resultStr = truncateToolResult(JSON.stringify(result));
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultStr });
      }

      workingMessages.push({ role: 'user', content: toolResults });
    }

    if (fullResponse) {
      onboardSession.messages.push({ role: 'assistant', content: fullResponse });
    }
    send({ done: true });
  } catch (err) {
    console.error('Onboard API error:', err.status, err.message);
    const msg = err.status === 429
      ? 'Rate limited — please wait a minute and try again.'
      : 'Something went wrong. Please try again.';
    send({ error: msg });
  }

  res.end();
});

// ── Complete onboarding ─────────────────────────────────────────────────────
router.post('/complete', (req, res) => {
  // Mark onboarding as done in config
  const saved = config.getSaved();
  saved._onboarded = true;
  config.save(saved);

  // Clear the onboarding session
  onboardSession = { messages: [], lastActive: Date.now() };

  res.json({ ok: true, message: 'Onboarding complete! Redirecting to chat.' });
});

// ── Check onboarding status ─────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const saved = config.getSaved();
  res.json({
    onboarded: !!saved._onboarded,
    hasSSH: sshAvailable,
  });
});

module.exports = router;
