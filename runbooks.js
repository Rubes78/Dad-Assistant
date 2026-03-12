/**
 * runbooks.js — pre-approved fix procedures
 *
 * Loads YAML runbook definitions from the runbooks/ directory.
 * Each runbook defines a series of check/action/verify steps that
 * the assistant can execute without tier restrictions (admin pre-approved).
 *
 * Runbook format:
 *   name: string
 *   description: string
 *   steps:
 *     - type: check|action|wait|verify|report
 *       command?: string (for check/action/verify)
 *       seconds?: number (for wait)
 *       message?: string (for report)
 *       expect?: string (for check/verify — 'non-empty', a status code, etc.)
 *       on_fail?: 'stop'|'continue' (default: 'stop')
 *       description?: string (human-readable description of this step)
 *       success_message?: string (for verify)
 *       failure_message?: string (for verify)
 *   notify_admin: boolean (default: true)
 */

const fs = require('fs');
const path = require('path');

// Optional YAML parser — fall back to basic parser if not available
let parseYaml;
try {
  parseYaml = require('js-yaml').load;
} catch {
  // Basic YAML parser for simple runbook files
  parseYaml = (text) => basicYamlParse(text);
}

const RUNBOOKS_DIR = process.env.RUNBOOKS_DIR || '/app/runbooks';
const ADMIN_NAME   = process.env.ADMIN_NAME   || 'your admin';

// ── Basic YAML parser (for simple flat/nested structures) ────────────────────
function basicYamlParse(text) {
  const lines = text.split('\n');
  const result = {};
  let currentKey = null;
  let currentList = null;
  let currentItem = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    // Skip comments and empty lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    const indent = line.search(/\S/);

    // Top-level key: value
    if (indent === 0 && line.includes(':')) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      currentKey = key.trim();
      if (value) {
        result[currentKey] = value === 'true' ? true : value === 'false' ? false : value;
        currentList = null;
      } else {
        result[currentKey] = [];
        currentList = result[currentKey];
      }
      currentItem = null;
      continue;
    }

    // List item
    if (currentList !== null && /^\s+-\s/.test(line)) {
      const content = line.replace(/^\s+-\s*/, '');
      if (content.includes(':')) {
        const [k, ...v] = content.split(':');
        currentItem = { [k.trim()]: v.join(':').trim() };
        currentList.push(currentItem);
      } else {
        currentItem = content;
        currentList.push(content);
      }
      continue;
    }

    // Continuation of list item (nested key: value)
    if (currentItem && typeof currentItem === 'object' && indent >= 4 && line.includes(':')) {
      const [k, ...v] = line.trim().split(':');
      const val = v.join(':').trim();
      currentItem[k.trim()] = val === 'true' ? true : val === 'false' ? false : val;
      continue;
    }
  }

  return result;
}

// ── Load runbooks from directory ─────────────────────────────────────────────
function loadRunbooks() {
  const runbookMap = new Map();

  if (!fs.existsSync(RUNBOOKS_DIR)) {
    console.log(`No runbooks directory found at ${RUNBOOKS_DIR}`);
    return runbookMap;
  }

  const files = fs.readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(RUNBOOKS_DIR, file), 'utf8');
      const runbook = parseYaml(content);
      if (runbook.name) {
        runbookMap.set(runbook.name, runbook);
        console.log(`Loaded runbook: ${runbook.name} (${file})`);
      }
    } catch (err) {
      console.warn(`Failed to load runbook ${file}:`, err.message);
    }
  }

  return runbookMap;
}

let runbookCache = loadRunbooks();

// Reload runbooks every 5 minutes (they're volume-mounted, may change)
setInterval(() => { runbookCache = loadRunbooks(); }, 5 * 60 * 1000);

/**
 * List available runbooks (for tool description).
 * @returns {Array<{name: string, description: string}>}
 */
function listRunbooks() {
  const list = [];
  for (const [name, rb] of runbookCache) {
    list.push({ name, description: rb.description || name });
  }
  return list;
}

/**
 * Execute a runbook by name.
 * @param {string} name — runbook name
 * @param {Function} runSsh — function to run SSH commands
 * @returns {Object} — execution results
 */
async function execute(name, runSsh) {
  const runbook = runbookCache.get(name);
  if (!runbook) {
    // Reload in case a new runbook was added
    runbookCache = loadRunbooks();
    const reloaded = runbookCache.get(name);
    if (!reloaded) {
      return { error: `Unknown runbook: ${name}. Available: ${[...runbookCache.keys()].join(', ')}` };
    }
  }

  const rb = runbookCache.get(name);
  const steps = rb.steps || [];
  const results = [];
  let success = true;

  console.log(`Executing runbook: ${name} (${steps.length} steps)`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepResult = { step: i + 1, type: step.type, description: step.description || '' };

    try {
      switch (step.type) {
        case 'check':
        case 'action':
        case 'verify': {
          if (!step.command) {
            stepResult.error = 'No command specified';
            break;
          }

          const cmdResult = await runSsh(step.command, 15000);
          stepResult.stdout = cmdResult.stdout;
          stepResult.stderr = cmdResult.stderr;

          // Check expectations
          if (step.expect) {
            const output = (cmdResult.stdout || '').trim();
            if (step.expect === 'non-empty') {
              stepResult.passed = output.length > 0;
            } else if (step.expect.startsWith('!= ')) {
              stepResult.passed = output !== step.expect.slice(3);
            } else {
              stepResult.passed = output.includes(step.expect);
            }

            if (!stepResult.passed) {
              if (step.type === 'verify') {
                stepResult.message = step.failure_message
                  ? step.failure_message.replace('{admin_name}', ADMIN_NAME)
                  : `Verification failed. Contact ${ADMIN_NAME}.`;
                success = false;
              }
              if (step.on_fail !== 'continue') {
                results.push(stepResult);
                if (step.type !== 'check') success = false;
                break;
              }
            } else if (step.type === 'verify' && step.success_message) {
              stepResult.message = step.success_message;
            }
          }
          break;
        }

        case 'wait': {
          const seconds = parseInt(step.seconds, 10) || 5;
          stepResult.description = `Waiting ${seconds} seconds`;
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          break;
        }

        case 'report': {
          stepResult.message = step.message
            ? step.message.replace('{admin_name}', ADMIN_NAME)
            : '';
          break;
        }

        default:
          stepResult.error = `Unknown step type: ${step.type}`;
      }
    } catch (err) {
      stepResult.error = err.message;
      success = false;
      if (step.on_fail !== 'continue') {
        results.push(stepResult);
        break;
      }
    }

    results.push(stepResult);
  }

  const summary = success
    ? `Runbook "${name}" completed successfully.`
    : `Runbook "${name}" completed with issues — check results.`;

  return {
    runbook: name,
    success,
    summary,
    steps: results,
    notify: rb.notify_admin !== false,
  };
}

module.exports = { listRunbooks, execute };
