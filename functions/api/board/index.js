// GET /api/board — the public board: approved features, vote counts, and
// whether the caller's anonymous cookie has voted on each.

import { PUBLIC_STATUSES, ensureSchema, issueVoterCookie, json, readVoterId } from './_util.js';
import { reviewPending } from './_review.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  await ensureSchema(db);
  if (env.OPENAI_API_KEY) {
    context.waitUntil(reviewPending(context).catch((error) =>
      console.error('roadmap AI backlog check failed', error?.message || 'unknown_error')));
  }

  const existingVoter = readVoterId(request);
  const voter = existingVoter || crypto.randomUUID();
  const placeholders = PUBLIC_STATUSES.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT f.id, f.title, f.detail, f.status, f.created_at,
        (SELECT COUNT(*) FROM votes v WHERE v.feature_id = f.id AND v.direction = 'up') AS upvotes,
        (SELECT COUNT(*) FROM votes v WHERE v.feature_id = f.id AND v.direction = 'down') AS downvotes,
        (SELECT direction FROM votes v2 WHERE v2.feature_id = f.id AND v2.voter_id = ?1) AS vote
      FROM features f
      WHERE f.status IN (${placeholders})
      ORDER BY upvotes DESC, f.created_at ASC`
    )
    .bind(voter, ...PUBLIC_STATUSES)
    .all();

  return json({
    siteKey: env.TURNSTILE_SITE_KEY || null,
    features: results.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      status: row.status,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      vote: row.vote,
      // Cached upvote-only pages still see upvotes, never a combined score.
      votes: row.upvotes,
      voted: row.vote === 'up',
      createdAt: row.created_at,
    })),
  }, { headers: existingVoter ? {} : { 'set-cookie': issueVoterCookie(voter, request) } });
}
