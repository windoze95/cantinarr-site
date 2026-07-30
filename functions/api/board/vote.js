// POST /api/board/vote — toggle the caller's vote on a feature.
// No account needed: votes are deduplicated by an anonymous first-party
// cookie, with a salted IP-hash rate limit as the abuse backstop.

import {
  LIMITS,
  VOTABLE_STATUSES,
  countRecent,
  ensureSchema,
  ipHash,
  isoSince,
  issueVoterCookie,
  json,
  readJsonBody,
  readVoterId,
} from './_util.js';

const HOUR_MS = 60 * 60 * 1000;

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'board_unconfigured' }, { status: 503 });
  await ensureSchema(db);

  const body = await readJsonBody(request);
  const id = body && Number.isInteger(body.id) ? body.id : null;
  if (!id || id < 1) return json({ error: 'bad_request' }, { status: 400 });

  const feature = await db
    .prepare(`SELECT id, status FROM features WHERE id = ?1`)
    .bind(id)
    .first();
  if (!feature || !VOTABLE_STATUSES.includes(feature.status)) {
    return json({ error: 'not_found' }, { status: 404 });
  }

  let voter = readVoterId(request);
  const newVoter = !voter;
  if (newVoter) voter = crypto.randomUUID();

  const existing = await db
    .prepare(`SELECT 1 AS present FROM votes WHERE feature_id = ?1 AND voter_id = ?2`)
    .bind(id, voter)
    .first();

  let voted;
  if (existing) {
    await db.prepare(`DELETE FROM votes WHERE feature_id = ?1 AND voter_id = ?2`).bind(id, voter).run();
    voted = false;
  } else {
    const hash = await ipHash(request, env);
    const recent = await countRecent(db, 'votes', hash, isoSince(HOUR_MS));
    if (recent >= LIMITS.voteInsertsPerIpPerHour) {
      return json({ error: 'rate_limited' }, { status: 429 });
    }
    await db
      .prepare(`INSERT INTO votes (feature_id, voter_id, ip_hash) VALUES (?1, ?2, ?3)`)
      .bind(id, voter, hash)
      .run();
    voted = true;
  }

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM votes WHERE feature_id = ?1`)
    .bind(id)
    .first();

  const headers = newVoter ? { 'set-cookie': issueVoterCookie(voter, request) } : {};
  return json({ ok: true, voted, votes: count ? count.n : 0 }, { headers });
}
