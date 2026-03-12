/**
 * notify.js — Apprise notification integration
 *
 * Sends push notifications to admins via Apprise (sidecar container).
 * If Apprise is not configured, notifications are silently skipped.
 */

const APPRISE_URL  = process.env.APPRISE_URL  || '';  // e.g. http://apprise:8000
const APPRISE_URLS = process.env.APPRISE_URLS || '';  // e.g. pover://user@token,tgram://bot/chat

const enabled = !!(APPRISE_URL && APPRISE_URLS);

if (enabled) {
  console.log('Apprise notifications enabled');
} else {
  console.log('Apprise notifications disabled (set APPRISE_URL and APPRISE_URLS to enable)');
}

// Cooldown tracking — don't spam the same notification
const cooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between identical notifications

/**
 * Send a notification via Apprise.
 * @param {string} title — notification title
 * @param {string} body — notification body
 * @param {Object} options — { type?: 'info'|'warning'|'failure', skipCooldown?: boolean }
 */
async function send(title, body, options = {}) {
  if (!enabled) return;

  // Cooldown check
  const key = `${title}:${body}`;
  if (!options.skipCooldown) {
    const lastSent = cooldowns.get(key);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) return;
  }
  cooldowns.set(key, Date.now());

  try {
    const res = await fetch(`${APPRISE_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: APPRISE_URLS,
        title: `Fatharr: ${title}`,
        body,
        type: options.type || 'info',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`Apprise notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('Apprise notification error:', err.message);
  }
}

// Clean up old cooldown entries every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [key, time] of cooldowns) {
    if (time < cutoff) cooldowns.delete(key);
  }
}, 30 * 60 * 1000);

module.exports = { send, enabled };
