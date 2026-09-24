// /api/board/admin — moderation endpoints, guarded by the ADMIN_TOKEN secret.
// GET lists every feature (including pending and declined); POST applies a
// moderation action. Used by /roadmap/admin.html.

import { ensureSchema, isAdmin, json, readJsonBody } from './_util.js';
import { reviewPending } from './_review.js';

const ACTIONS = {
  approve: 'open',
  open: 'open',
  planned: 'planned',
  shipped: 'shipped',
  decline: 'declined',
};

async function guard(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_unconfigured' }, { status: 503 });
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  const denied = await guard(request, env);
  if (denied) return denied;
  await ensureSchema(db);
  if (env.OPENAI_API_KEY) {
    context.waitUntil(reviewPending(context).catch((error) =>
      console.error('roadmap AI backlog check failed', error?.message || 'unknown_error')));
  }

  const { results } = await db
    .prepare(
      `SELECT f.id, f.title, f.detail, f.status, f.created_at,
        (SELECT COUNT(*) FROM votes v WHERE v.feature_id = f.id) AS votes,
        r.state AS review_state, r.recommendation, r.reason, r.reviewed_at
      FROM features f
      LEFT JOIN feature_reviews r ON r.feature_id = f.id
      ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, votes DESC, f.created_at DESC`
    )
    .all();

  return json({
    reviewEnabled: Boolean(env.OPENAI_API_KEY),
    features: results.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      status: row.status,
      votes: row.votes,
      createdAt: row.created_at,
      review: row.review_state === 'completed' ? {
        model: 'gpt-6-luna',
        recommendation: row.recommendation,
        reason: row.reason,
        reviewedAt: row.reviewed_at,
      } : null,
      reviewState: row.review_state || (row.status === 'pending' ? 'awaiting' : null),
    })),
  });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  const denied = await guard(request, env);
  if (denied) return denied;
  await ensureSchema(db);

  const body = await readJsonBody(request);
  const id = body && Number.isInteger(body.id) ? body.id : null;
  const action = body ? body.action : null;
  if (!id || id < 1 || (!ACTIONS[action] && action !== 'delete')) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const feature = await db.prepare(`SELECT id FROM features WHERE id = ?1`).bind(id).first();
  if (!feature) return json({ error: 'not_found' }, { status: 404 });

  if (action === 'delete') {
    await db.batch([
      db.prepare(`DELETE FROM votes WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_reviews WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM features WHERE id = ?1`).bind(id),
    ]);
    return json({ ok: true, deleted: true });
  }

  await db.prepare(`UPDATE features SET status = ?2 WHERE id = ?1`).bind(id, ACTIONS[action]).run();
  return json({ ok: true, status: ACTIONS[action] });
}
