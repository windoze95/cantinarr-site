// Shared helpers for the feature board API (/api/board*).
// Storage is the D1 binding `DB` declared in wrangler.toml. The schema is
// created here on first use so a fresh database needs no manual migration.

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    feature_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (feature_id, voter_id)
  )`,
  `CREATE INDEX IF NOT EXISTS votes_ip_time ON votes (ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS submission_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS submission_ip_time ON submission_log (ip_hash, created_at)`,
];

// Public statuses are visible on /roadmap/; votable ones accept vote toggles.
export const PUBLIC_STATUSES = ['open', 'planned', 'shipped'];
export const VOTABLE_STATUSES = ['open', 'planned'];

export const LIMITS = {
  titleMin: 4,
  titleMax: 120,
  detailMax: 2000,
  submissionsPerIpPerDay: 5,
  voteInsertsPerIpPerHour: 40,
};

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Voters are keyed by an anonymous first-party cookie, not an account.
const VOTER_COOKIE = 'cb_uid';
const VOTER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readVoterId(request) {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === VOTER_COOKIE) {
      const value = rest.join('=');
      if (VOTER_ID_PATTERN.test(value)) return value;
    }
  }
  return null;
}

export function issueVoterCookie(voterId, request) {
  // Secure only over https so `wrangler pages dev` (plain-http localhost)
  // can round-trip the cookie during local testing.
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${VOTER_COOKIE}=${voterId}; Max-Age=63072000; Path=/;${secure} HttpOnly; SameSite=Lax`;
}

// IPs are never stored raw — only a salted hash used for rate limiting.
export async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  return sha256Hex(`${env.VOTE_SALT || 'cantinarr-board'}|${ip}`);
}

export function isoSince(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

export async function countRecent(db, table, hash, sinceIso) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ip_hash = ?1 AND created_at > ?2`)
    .bind(hash, sinceIso)
    .first();
  return row ? row.n : 0;
}

// With no TURNSTILE_SECRET configured the board still works (bootstrap mode);
// rate limits and the moderation queue remain the backstop.
export async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  if (!res.ok) return false;
  const outcome = await res.json();
  return outcome.success === true;
}

export async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  const [given, expected] = await Promise.all([sha256Hex(token), sha256Hex(env.ADMIN_TOKEN)]);
  return given === expected;
}

export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Fire-and-forget moderation alert for a newly queued idea, published to a
// secret ntfy topic (phone push). Runs through waitUntil and swallows
// errors: notifications must never delay or fail a submission.
export function notifyNewSubmission(context, env, title, detail) {
  if (!env.NTFY_TOPIC) return;
  const payload = {
    topic: env.NTFY_TOPIC,
    title: 'New Cantinarr feature idea',
    message: detail ? `${title}\n\n${detail.slice(0, 500)}` : title,
    click: 'https://cantinarr.com/roadmap/admin.html',
    tags: ['bulb'],
  };
  // Only observable via `wrangler pages deployment tail`; failures stay silent
  // for the submitter.
  context.waitUntil(
    fetch(env.NTFY_URL || 'https://ntfy.sh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (r) => {
        if (!r.ok) console.error('ntfy publish failed', r.status, (await r.text()).slice(0, 200));
      })
      .catch((err) => console.error('ntfy publish error', err && err.message))
  );
}

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}
