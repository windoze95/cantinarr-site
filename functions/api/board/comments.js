// Visitor comments wait for manual approval. Maintainer comments and the
// separate, always-visible card response are written through the admin API.
import {
  LIMITS, PUBLIC_STATUSES, cleanText, ensureSchema, ipHash, isoSince,
  isAdmin, json, readJsonBody, verifyTurnstile,
} from './_util.js';

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function queryInteger(value, minimum) {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  const admin = await isAdmin(request, env);
  if (request.headers.has('authorization') && !admin) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const query = new URL(request.url).searchParams;
  const id = queryInteger(query.get('id'), 1);
  const after = query.has('after') ? queryInteger(query.get('after'), 0) : 0;
  if (!id || after === null) return json({ error: 'bad_request' }, { status: 400 });
  await ensureSchema(db);
  const feature = await db.prepare('SELECT status FROM features WHERE id = ?1').bind(id).first();
  if (!feature || (!admin && !PUBLIC_STATUSES.includes(feature.status))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const { results } = await db.prepare(`SELECT c.id, c.body, c.author, c.status, c.created_at
    FROM feature_comments c JOIN features f ON f.id = c.feature_id
    WHERE c.feature_id = ?1 AND c.id > ?2
      ${admin ? '' : "AND c.status = 'approved' AND f.status IN ('open', 'planned', 'shipped')"}
    ORDER BY c.id ASC LIMIT ?3`).bind(id, after, PAGE_SIZE + 1).all();
  const page = results.slice(0, PAGE_SIZE);
  return json({
    comments: page.map((row) => ({
      id: row.id, body: row.body, author: row.author, status: row.status, createdAt: row.created_at,
    })),
    nextCursor: results.length > PAGE_SIZE ? page.at(-1).id : null,
  });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });
  if (typeof body.website === 'string' && body.website.trim()) {
    return json({ ok: true, queued: true });
  }
  if (!Number.isSafeInteger(body.id) || body.id < 1) {
    return json({ error: 'bad_request' }, { status: 400 });
  }
  const text = cleanText(body.body, LIMITS.commentMax + 1);
  if (typeof body.body !== 'string' || !text || text.length > LIMITS.commentMax) {
    return json({ error: 'invalid_comment' }, { status: 400 });
  }
  await ensureSchema(db);
  const feature = await db.prepare('SELECT status FROM features WHERE id = ?1').bind(body.id).first();
  if (!feature || !PUBLIC_STATUSES.includes(feature.status)) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  if (!(await verifyTurnstile(env, body.turnstile, request))) {
    return json({ error: 'turnstile_failed' }, { status: 403 });
  }
  const hash = await ipHash(request, env);
  const entryId = crypto.randomUUID();
  try {
    // The rate reservation and comment write share a serialized D1 transaction.
    // Deleting a rejected comment never restores an attacker's daily allowance.
    const [reservation, , snapshot] = await db.batch([
      db.prepare(`INSERT INTO comment_log (id, ip_hash)
        SELECT ?1, ?2 FROM features WHERE id = ?3 AND status IN ('open', 'planned', 'shipped')
          AND (SELECT COUNT(*) FROM comment_log WHERE ip_hash = ?2 AND created_at > ?4) < ?5`)
        .bind(entryId, hash, body.id, isoSince(DAY_MS), LIMITS.commentsPerIpPerDay),
      db.prepare(`INSERT INTO feature_comments (feature_id, body, author, status, ip_hash)
        SELECT ?1, ?2, 'visitor', 'pending', ip_hash FROM comment_log WHERE id = ?3
          AND EXISTS (SELECT 1 FROM features WHERE id = ?1 AND status IN ('open', 'planned', 'shipped'))`)
        .bind(body.id, text, entryId),
      db.prepare('SELECT status FROM features WHERE id = ?1').bind(body.id),
    ]);
    const current = snapshot.results[0];
    if (!current || !PUBLIC_STATUSES.includes(current.status)) {
      return json({ error: 'not_found' }, { status: 404 });
    }
    if (!reservation.meta.changes) return json({ error: 'rate_limited' }, { status: 429 });
    return json({ ok: true, queued: true });
  } catch {
    return json({ error: 'comments_unavailable' }, { status: 503 });
  }
}
