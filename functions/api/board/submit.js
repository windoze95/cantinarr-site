// POST /api/board/submit — accept a feature idea into the moderation queue.
// Layered abuse protection: honeypot field, Turnstile (when configured),
// per-IP daily rate limit, and human review before anything is published.

import {
  LIMITS,
  cleanText,
  countRecent,
  ensureSchema,
  ipHash,
  isoSince,
  json,
  readJsonBody,
  verifyTurnstile,
} from './_util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  await ensureSchema(db);

  const body = await readJsonBody(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  // Honeypot: real users never see this field. Pretend success, store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, queued: true });
  }

  const title = cleanText(body.title, LIMITS.titleMax);
  const detail = cleanText(body.detail, LIMITS.detailMax);
  if (title.length < LIMITS.titleMin) {
    return json({ error: 'invalid_title' }, { status: 400 });
  }

  const hash = await ipHash(request, env);
  const recent = await countRecent(db, 'submission_log', hash, isoSince(DAY_MS));
  if (recent >= LIMITS.submissionsPerIpPerDay) {
    return json({ error: 'rate_limited' }, { status: 429 });
  }

  const human = await verifyTurnstile(env, body.turnstile, request);
  if (!human) return json({ error: 'turnstile_failed' }, { status: 403 });

  await db.batch([
    db.prepare(`INSERT INTO features (title, detail, status) VALUES (?1, ?2, 'pending')`).bind(title, detail),
    db.prepare(`INSERT INTO submission_log (ip_hash) VALUES (?1)`).bind(hash),
  ]);

  return json({ ok: true, queued: true });
}
