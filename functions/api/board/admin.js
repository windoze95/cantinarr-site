// /api/board/admin — moderation endpoints, guarded by the ADMIN_TOKEN secret.
// GET lists every feature (including pending and declined); POST applies a
// moderation action. Used by /roadmap/admin.html.

import { LIMITS, cleanText, ensureSchema, isAdmin, json, normalizeGitHubIssueUrl, readJsonBody } from './_util.js';
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
        (SELECT COUNT(*) FROM feature_comments c WHERE c.feature_id = f.id AND c.status = 'approved') AS comment_count,
        (SELECT COUNT(*) FROM feature_comments c WHERE c.feature_id = f.id AND c.status = 'pending') AS pending_comment_count,
        response.body AS maintainer_response, response.updated_at AS response_updated_at,
        issue.issue_url AS github_issue_url,
        contact.email AS contact_email, contact.discord AS contact_discord,
        (SELECT COUNT(*) FROM votes v WHERE v.feature_id = f.id AND v.direction = 'up') AS upvotes,
        (SELECT COUNT(*) FROM votes v WHERE v.feature_id = f.id AND v.direction = 'down') AS downvotes,
        r.state AS review_state, r.recommendation, r.reason, r.reviewed_at
      FROM features f
      LEFT JOIN feature_reviews r ON r.feature_id = f.id
      LEFT JOIN feature_responses response ON response.feature_id = f.id
      LEFT JOIN feature_issue_links issue ON issue.feature_id = f.id
      LEFT JOIN feature_contacts contact ON contact.feature_id = f.id
      ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, upvotes DESC, f.created_at DESC`
    )
    .all();

  return json({
    reviewEnabled: Boolean(env.OPENAI_API_KEY),
    features: results.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      status: row.status,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      votes: row.upvotes,
      createdAt: row.created_at,
      commentCount: row.comment_count,
      pendingCommentCount: row.pending_comment_count,
      maintainerResponse: row.maintainer_response || '',
      responseUpdatedAt: row.response_updated_at || null,
      githubIssueUrl: row.github_issue_url || '',
      contactEmail: row.contact_email || '',
      contactDiscord: row.contact_discord || '',
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
  const id = body && Number.isSafeInteger(body.id) ? body.id : null;
  const action = body ? body.action : null;
  if (!id || id < 1 || (!Object.hasOwn(ACTIONS, action) &&
      !['delete', 'comment', 'respond', 'approve_comment', 'delete_comment', 'link_issue'].includes(action))) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const feature = await db.prepare(`SELECT id FROM features WHERE id = ?1`).bind(id).first();
  if (!feature) return json({ error: 'not_found' }, { status: 404 });

  if (action === 'delete') {
    await db.batch([
      db.prepare(`DELETE FROM votes WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_reviews WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_comments WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_responses WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_issue_links WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM feature_contacts WHERE feature_id = ?1`).bind(id),
      db.prepare(`DELETE FROM features WHERE id = ?1`).bind(id),
    ]);
    return json({ ok: true, deleted: true });
  }

  if (action === 'link_issue') {
    const url = normalizeGitHubIssueUrl(body.url);
    if (url === null) return json({ error: 'invalid_issue_url' }, { status: 400 });
    if (url) {
      const result = await db.prepare(`INSERT INTO feature_issue_links (feature_id, issue_url)
        SELECT id, ?2 FROM features WHERE id = ?1
        ON CONFLICT (feature_id) DO UPDATE SET issue_url = excluded.issue_url`).bind(id, url).run();
      if (!result.meta.changes) return json({ error: 'not_found' }, { status: 404 });
    } else {
      await db.prepare('DELETE FROM feature_issue_links WHERE feature_id = ?1').bind(id).run();
    }
    return json({ ok: true, githubIssueUrl: url });
  }

  if (action === 'comment' || action === 'respond') {
    const max = action === 'comment' ? LIMITS.commentMax : LIMITS.responseMax;
    const text = cleanText(body.body, max + 1);
    if (typeof body.body !== 'string' || text.length > max || (action === 'comment' && !text)) {
      return json({ error: action === 'comment' ? 'invalid_comment' : 'invalid_response' }, { status: 400 });
    }
    if (action === 'comment') {
      await db.prepare(`INSERT INTO feature_comments (feature_id, body, author, status)
        SELECT id, ?2, 'maintainer', 'approved' FROM features WHERE id = ?1`).bind(id, text).run();
    } else if (text) {
      await db.prepare(`INSERT INTO feature_responses (feature_id, body)
        SELECT id, ?2 FROM features WHERE id = ?1
        ON CONFLICT (feature_id) DO UPDATE SET body = excluded.body,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(id, text).run();
    } else {
      await db.prepare(`DELETE FROM feature_responses WHERE feature_id = ?1`).bind(id).run();
    }
    return json({ ok: true });
  }

  if (action === 'approve_comment' || action === 'delete_comment') {
    if (!Number.isSafeInteger(body.commentId) || body.commentId < 1) {
      return json({ error: 'bad_request' }, { status: 400 });
    }
    const mutation = action === 'approve_comment'
      ? `UPDATE feature_comments SET status = 'approved' WHERE id = ?1 AND feature_id = ?2`
      : `DELETE FROM feature_comments WHERE id = ?1 AND feature_id = ?2`;
    const result = await db.prepare(mutation).bind(body.commentId, id).run();
    if (!result.meta.changes) return json({ error: 'not_found' }, { status: 404 });
    return json({ ok: true });
  }

  await db.prepare(`UPDATE features SET status = ?2 WHERE id = ?1`).bind(id, ACTIONS[action]).run();
  return json({ ok: true, status: ACTIONS[action] });
}
