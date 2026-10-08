// POST /api/board/vote — set the caller's anonymous vote to up, down, or null.
// Explicit desired states are idempotent, including retries after a lost reply.

import {
  LIMITS, VOTABLE_STATUSES, ensureSchema, ipHash, isoSince,
  issueVoterCookie, json, readJsonBody, readVoterId,
} from './_util.js';

const HOUR_MS = 60 * 60 * 1000;

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  await ensureSchema(db);

  const body = await readJsonBody(request);
  const id = body && Number.isSafeInteger(body.id) ? body.id : null;
  const legacy = body && !Object.hasOwn(body, 'vote');
  if (!id || id < 1 || (!legacy && ![null, 'up', 'down'].includes(body.vote))) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const existingVoter = readVoterId(request);
  const voter = existingVoter || crypto.randomUUID();
  let vote = body.vote;
  // Preserve sequential toggles from cached upvote-only pages. New clients
  // always send an explicit state; these requests are safe to repeat.
  if (legacy) {
    const existing = await db.prepare('SELECT direction FROM votes WHERE feature_id = ?1 AND voter_id = ?2')
      .bind(id, voter).first();
    vote = existing?.direction === 'up' ? null : 'up';
  }

  const hash = await ipHash(request, env);
  const statuses = VOTABLE_STATUSES.map((_, i) => `?${i + 7}`).join(', ');
  const values = [id, voter, vote, hash, isoSince(HOUR_MS), LIMITS.voteInsertsPerIpPerHour, ...VOTABLE_STATUSES];
  const mutation = vote === null
    ? db.prepare(`DELETE FROM votes WHERE feature_id = ?1 AND voter_id = ?2
        AND EXISTS (SELECT 1 FROM features WHERE id = ?1 AND status IN (${statuses}))`).bind(...values)
    : db.prepare(`INSERT INTO votes (feature_id, voter_id, direction, ip_hash)
        SELECT ?1, ?2, ?3, ?4 FROM features WHERE id = ?1 AND status IN (${statuses})
        AND (EXISTS (SELECT 1 FROM votes WHERE feature_id = ?1 AND voter_id = ?2)
          OR (SELECT COUNT(*) FROM votes WHERE ip_hash = ?4 AND created_at > ?5) < ?6)
        ON CONFLICT (feature_id, voter_id) DO UPDATE SET direction = excluded.direction`).bind(...values);

  try {
    // D1 batches are transactions: the status/rate guard, write, caller state,
    // and both counts share one serialized snapshot. No read/insert race.
    const [, snapshot] = await db.batch([
      mutation,
      db.prepare(`SELECT f.status,
          (SELECT COUNT(*) FROM votes WHERE feature_id = f.id AND direction = 'up') AS upvotes,
          (SELECT COUNT(*) FROM votes WHERE feature_id = f.id AND direction = 'down') AS downvotes,
          (SELECT direction FROM votes WHERE feature_id = f.id AND voter_id = ?2) AS vote
        FROM features f WHERE f.id = ?1`).bind(id, voter),
    ]);
    const row = snapshot.results[0];
    if (!row || !VOTABLE_STATUSES.includes(row.status)) {
      return json({ error: 'not_found' }, { status: 404 });
    }
    if (vote !== null && row.vote !== vote) {
      return json({ error: 'rate_limited' }, { status: 429 });
    }
    return json({
      ok: true, vote: row.vote, upvotes: row.upvotes, downvotes: row.downvotes,
      // Compatibility aliases always describe upvotes, never a net score.
      voted: row.vote === 'up', votes: row.upvotes,
    }, { headers: existingVoter ? {} : { 'set-cookie': issueVoterCookie(voter, request) } });
  } catch {
    return json({ error: 'vote_unavailable' }, { status: 503 });
  }
}
