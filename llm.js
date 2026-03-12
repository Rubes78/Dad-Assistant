/**
 * llm.js — LLM provider adapter
 *
 * Supports two providers:
 *   - "anthropic" (default) — uses @anthropic-ai/sdk directly
 *   - "openrouter" — translates to OpenAI format for OpenRouter's API
 *
 * Both server.js and onboard.js call llm.create() with Anthropic-style params.
 * This module handles the translation so the rest of the codebase stays unchanged.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

// ── Provider detection ──────────────────────────────────────────────────────
function getProvider() {
  return config.get('LLM_PROVIDER', 'anthropic');
}

function getApiKey() {
  const provider = getProvider();
  if (provider === 'openrouter') {
    return config.get('OPENROUTER_API_KEY') || config.get('ANTHROPIC_API_KEY', '');
  }
  return config.get('ANTHROPIC_API_KEY', '');
}

// ── Model ID mapping ────────────────────────────────────────────────────────
// Maps internal model IDs to provider-specific IDs
const MODEL_MAP = {
  anthropic: {
    cheap:    'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-6',
    smart:    'claude-opus-4-6',
  },
  openrouter: {
    cheap:    'anthropic/claude-haiku-4.5',
    standard: 'anthropic/claude-sonnet-4.6',
    smart:    'anthropic/claude-opus-4.6',
  },
};

// Reverse map: provider model ID → tier name
function modelToTier(modelId) {
  for (const [provider, models] of Object.entries(MODEL_MAP)) {
    for (const [tier, id] of Object.entries(models)) {
      if (id === modelId) return tier;
    }
  }
  return null;
}

function resolveModel(requestedModel) {
  const provider = getProvider();
  const map = MODEL_MAP[provider] || MODEL_MAP.anthropic;

  // If it's a tier name, resolve it
  if (map[requestedModel]) return map[requestedModel];

  // If it's already a provider-specific ID for the current provider, use it
  if (Object.values(map).includes(requestedModel)) return requestedModel;

  // If it's from the other provider, translate via tier
  const tier = modelToTier(requestedModel);
  if (tier && map[tier]) return map[tier];

  // Default to standard
  return map.standard;
}

function getAllowedModels() {
  const provider = getProvider();
  const map = MODEL_MAP[provider] || MODEL_MAP.anthropic;
  return Object.values(map);
}

function getDefaultModel() {
  const provider = getProvider();
  const map = MODEL_MAP[provider] || MODEL_MAP.anthropic;
  const configured = config.get('CLAUDE_MODEL');
  if (configured) return resolveModel(configured);
  return map.standard;
}

function getOnboardModel() {
  const provider = getProvider();
  const map = MODEL_MAP[provider] || MODEL_MAP.anthropic;
  const configured = config.get('ONBOARD_MODEL');
  if (configured) return resolveModel(configured);
  return map.cheap;
}

// ── Anthropic provider ──────────────────────────────────────────────────────
function createAnthropicClient() {
  return new Anthropic({ apiKey: getApiKey() });
}

async function anthropicCreate(opts) {
  const client = createAnthropicClient();
  return client.messages.create(opts);
}

// ── OpenRouter provider (OpenAI-compatible) ─────────────────────────────────

// Convert Anthropic tool definitions to OpenAI format
function toolsToOpenAI(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Convert Anthropic messages to OpenAI format
function messagesToOpenAI(messages, systemPrompt) {
  const out = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Could be tool_result array (from user) or content blocks (from assistant)
      if (msg.role === 'user') {
        // Check if these are tool results
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        if (toolResults.length) {
          for (const tr of toolResults) {
            out.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          // Regular content blocks
          out.push({ role: 'user', content: msg.content.map(b => b.text || '').join('') });
        }
      } else if (msg.role === 'assistant') {
        // Assistant message with potential tool_use blocks
        const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        const openaiMsg = { role: 'assistant', content: textParts || null };
        if (toolUses.length) {
          openaiMsg.tool_calls = toolUses.map(tu => ({
            id: tu.id,
            type: 'function',
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          }));
        }
        out.push(openaiMsg);
      }
    }
  }
  return out;
}

// Convert OpenAI response back to Anthropic format
function responseToAnthropic(openaiResp) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return { content: [], stop_reason: 'end_turn' };
  }

  const content = [];
  const msg = choice.message;

  // Text content
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Tool calls → tool_use blocks
  if (msg.tool_calls && msg.tool_calls.length) {
    for (const tc of msg.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map stop reason
  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens';

  return { content, stop_reason };
}

async function openrouterCreate(opts) {
  const apiKey = getApiKey();
  const openaiMessages = messagesToOpenAI(opts.messages, opts.system);
  const openaiTools = toolsToOpenAI(opts.tools);

  const body = {
    model: opts.model,
    max_tokens: opts.max_tokens,
    messages: openaiMessages,
  };
  if (openaiTools) body.tools = openaiTools;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Rubes78/Dad-Assistant',
      'X-Title': 'Fatharr',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`OpenRouter API error: HTTP ${res.status} — ${errBody.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  return responseToAnthropic(json);
}

// ── Unified create function ─────────────────────────────────────────────────
async function create(opts) {
  const provider = getProvider();
  if (provider === 'openrouter') {
    return openrouterCreate(opts);
  }
  return anthropicCreate(opts);
}

// ── Check if configured ─────────────────────────────────────────────────────
function isConfigured() {
  return !!getApiKey();
}

module.exports = {
  create,
  getProvider,
  getApiKey,
  resolveModel,
  getAllowedModels,
  getDefaultModel,
  getOnboardModel,
  isConfigured,
  MODEL_MAP,
};
