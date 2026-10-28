import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureSchema, ipHash } from '../../functions/api/board/_util.js';
import { onRequestGet as commentsGet, onRequestPost as commentsPost } from '../../functions/api/board/comments.js';
import { onRequestGet as boardGet } from '../../functions/api/board/index.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../../functions/api/board/admin.js';

class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute() {
    this.db.fail?.(this.sql);
    const query = this.db.sqlite.prepare(this.sql);
    if (query.columns().length) return { results: query.all(...this.values), meta: { changes: 0 } };
    const result = query.run(...this.values);
    return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
  async all() { return this.execute(); }
  async first() { return this.execute().results[0] || null; }
  async run() { return this.execute(); }
}
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
function request(path, body, token) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(`https://example.test/api/board${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function invoke(handler, env, req) {
  const response = await handler({ env, request: req });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const post = (env, body) => invoke(commentsPost, env, request('/comments', body));
const get = (env, id = 1, token, after) => invoke(commentsGet, env,
  request(`/comments?id=${id}${after === undefined ? '' : `&after=${after}`}`, undefined, token));
const act = (env, body, token = 'local-admin') => invoke(adminPost, env, request('/admin', body, token));
const count = (env, table) => env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
async function setup(t) {
  const db = new D1(); t.after(() => db.sqlite.close());
  await ensureSchema(db);
  db.sqlite.exec(`INSERT INTO features (id, title, status) VALUES
    (1, 'Open idea', 'open'), (2, 'Planned idea', 'planned'), (3, 'Shipped idea', 'shipped'),
    (4, 'Hidden idea', 'pending'), (5, 'Declined idea', 'declined')`);
  return { DB: db, ADMIN_TOKEN: 'local-admin', VOTE_SALT: 'test-salt' };
}

test('additive comment schema preserves old features and votes', async (t) => {
  const db = new D1(); t.after(() => db.sqlite.close());
  db.sqlite.exec(`CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT 'old');
    CREATE TABLE votes (feature_id INTEGER NOT NULL, voter_id TEXT NOT NULL, ip_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT 'old', PRIMARY KEY (feature_id, voter_id));
    INSERT INTO features VALUES (1, 'Existing idea', 'Original detail', 'open', 'original-date');
    INSERT INTO votes VALUES (1, 'old-voter', 'original-hash', 'original-date')`);
  await Promise.all([ensureSchema(db), ensureSchema(db)]);
  assert.equal(db.sqlite.prepare('SELECT title FROM features').get().title, 'Existing idea');
  assert.equal(db.sqlite.prepare('SELECT direction FROM votes').get().direction, 'up');
  assert.equal((await get({ DB: db })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT created_at FROM features').get().created_at, 'original-date');
});

test('visitor comment is pending until approved and never exposes identity data', async (t) => {
  const env = await setup(t);
  const submitted = await post(env, { id: 1, body: '  First\r\ncomment\u0000  ', author: 'maintainer', status: 'approved' });
  assert.deepEqual(submitted.body, { ok: true, queued: true });
  assert.deepEqual((await get(env)).body, { comments: [], nextCursor: null });
  const pending = await get(env, 1, 'local-admin');
  assert.equal(pending.body.comments.length, 1);
  const comment = pending.body.comments[0];
  assert.equal(comment.body, 'First\ncomment');
  assert.equal(comment.author, 'visitor');
  assert.equal(comment.status, 'pending');
  assert.deepEqual(Object.keys(comment).sort(), ['author', 'body', 'createdAt', 'id', 'status']);
  const row = env.DB.sqlite.prepare('SELECT * FROM feature_comments').get();
  assert.equal(row.ip_hash, await ipHash(request('/comments', {}), env));
  assert.ok(!JSON.stringify(pending.body).includes(row.ip_hash));
  const admin = await invoke(adminGet, env, request('/admin', undefined, 'local-admin'));
  const feature = admin.body.features.find((f) => f.id === 1);
  assert.equal(feature.commentCount, 0); assert.equal(feature.pendingCommentCount, 1);
  assert.equal((await act(env, { id: 1, action: 'approve_comment', commentId: comment.id })).status, 200);
  assert.equal((await get(env)).body.comments[0].status, 'approved');
  const publicBoard = await invoke(boardGet, env, request(''));
  const publicFeature = publicBoard.body.features.find((f) => f.id === 1);
  assert.equal(publicFeature.commentCount, 1);
  assert.ok(!Object.hasOwn(publicFeature, 'pendingCommentCount'));
  assert.equal(publicBoard.headers.get('cache-control'), 'no-store');
});

test('maintainer discussion and the pinned response stay separate through edit and clear', async (t) => {
  const env = await setup(t);
  assert.equal((await act(env, { id: 1, action: 'comment', body: 'Discussion reply' })).status, 200);
  assert.equal((await act(env, { id: 1, action: 'respond', body: 'Official response' })).status, 200);
  const comments = (await get(env)).body.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].author, 'maintainer'); assert.equal(comments[0].body, 'Discussion reply');
  let board = await invoke(boardGet, env, request(''));
  let feature = board.body.features.find((f) => f.id === 1);
  assert.equal(feature.maintainerResponse, 'Official response'); assert.ok(feature.responseUpdatedAt);
  assert.equal(feature.commentCount, 1);
  await act(env, { id: 1, action: 'respond', body: 'Updated response' });
  assert.equal(count(env, 'feature_responses'), 1);
  const admin = await invoke(adminGet, env, request('/admin', undefined, 'local-admin'));
  assert.equal(admin.body.features.find((f) => f.id === 1).maintainerResponse, 'Updated response');
  await act(env, { id: 1, action: 'respond', body: ' \n ' });
  board = await invoke(boardGet, env, request('')); feature = board.body.features.find((f) => f.id === 1);
  assert.equal(feature.maintainerResponse, ''); assert.equal(feature.responseUpdatedAt, null);
  assert.equal((await get(env)).body.comments.length, 1);
});

test('admin reads and all write actions require the token and comments are scoped to their feature', async (t) => {
  const env = await setup(t);
  for (const token of ['', 'wrong']) {
    assert.equal((await get(env, 1, token)).status, 401);
    assert.equal((await invoke(adminGet, env, request('/admin', undefined, token))).status, 401);
    for (const action of ['comment', 'respond', 'approve_comment', 'delete_comment']) {
      assert.equal((await act(env, { id: 1, action, body: 'Unauthorized', commentId: 1 }, token)).status, 401);
    }
  }
  await post(env, { id: 1, body: 'Awaiting decision' });
  const commentId = (await get(env, 1, 'local-admin')).body.comments[0].id;
  for (const action of ['approve_comment', 'delete_comment']) {
    assert.equal((await act(env, { id: 2, action, commentId })).status, 404);
  }
  assert.equal((await get(env)).body.comments.length, 0);
  assert.equal((await act(env, { id: 1, action: 'delete_comment', commentId })).status, 200);
  assert.equal(count(env, 'feature_comments'), 0);
  assert.equal(count(env, 'comment_log'), 1, 'moderation does not reset the abuse allowance');
});

test('public comments cover shipped items but cannot reveal or post to hidden or missing ideas', async (t) => {
  const env = await setup(t);
  for (const id of [1, 2, 3]) assert.equal((await post(env, { id, body: 'Public discussion' })).status, 200);
  for (const id of [4, 5, 999]) {
    assert.equal((await get(env, id)).status, 404);
    assert.equal((await post(env, { id, body: 'Hidden discussion' })).status, 404);
  }
  assert.equal((await act(env, { id: 4, action: 'comment', body: 'Prepare a maintainer reply' })).status, 200);
  assert.equal((await get(env, 4, 'local-admin')).body.comments.length, 1);
  assert.equal((await get(env, 4)).status, 404);
  assert.equal((await get({}, 1)).status, 503);
  assert.equal((await post({}, { id: 1, body: 'Unavailable' })).status, 503);
});

test('invalid bodies and cursors reject without writes; honeypot quietly stores nothing', async (t) => {
  const env = await setup(t);
  for (const body of [null, {}, { id: '1', body: 'Test' }, { id: -1, body: 'Test' },
    { id: Number.MAX_SAFE_INTEGER + 1, body: 'Test' }, { id: 1, body: null },
    { id: 1, body: '' }, { id: 1, body: '\u0000 \n ' }, { id: 1, body: 'x'.repeat(2001) }]) {
    assert.equal((await post(env, body)).status, 400);
  }
  for (const id of ['', '1.5', '-1', 'null', '9007199254740992']) assert.equal((await get(env, id)).status, 400);
  for (const after of ['', '-1', '1.5', 'nope', '9007199254740992']) assert.equal((await get(env, 1, undefined, after)).status, 400);
  for (const action of ['comment', 'respond']) {
    assert.equal((await act(env, { id: 1, action, body: 4 })).status, 400);
    assert.equal((await act(env, { id: 1, action, body: 'x'.repeat(2001) })).status, 400);
  }
  assert.equal((await act(env, { id: 1, action: 'comment', body: '' })).status, 400);
  assert.equal((await act(env, { id: 1, action: 'approve_comment', commentId: '1' })).status, 400);
  assert.equal((await act(env, { id: 1, action: 'toString' })).status, 400);
  assert.equal((await post(env, { id: 1, body: 'Spam', website: 'https://spam.test' })).status, 200);
  assert.equal(count(env, 'feature_comments'), 0); assert.equal(count(env, 'comment_log'), 0);
});

test('Turnstile gates visitor comments and admin publishing bypasses it', async (t) => {
  const env = await setup(t); env.TURNSTILE_SECRET = 'local-test-secret';
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ success: options.body.get('response') === 'valid' }));
  };
  assert.equal((await post(env, { id: 1, body: 'Missing challenge' })).status, 403);
  assert.equal((await post(env, { id: 1, body: 'Failed challenge', turnstile: 'invalid' })).status, 403);
  assert.equal((await post(env, { id: 1, body: 'Passed challenge', turnstile: 'valid' })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal((await act(env, { id: 1, action: 'comment', body: 'Admin reply' })).status, 200);
  assert.equal(calls.length, 2);
});

test('comment rate reservation is atomic for racing posts and failures roll back both writes', async (t) => {
  const env = await setup(t); const db = env.DB;
  for (let i = 0; i < 9; i++) assert.equal((await post(env, { id: 1, body: `Comment ${i}` })).status, 200);
  const racers = await Promise.all([post(env, { id: 1, body: 'Race one' }), post(env, { id: 1, body: 'Race two' })]);
  assert.deepEqual(racers.map((result) => result.status).sort(), [200, 429]);
  assert.equal(count(env, 'feature_comments'), 10); assert.equal(count(env, 'comment_log'), 10);
  db.sqlite.exec('DELETE FROM feature_comments');
  assert.equal((await post(env, { id: 1, body: 'Deleted comments still count' })).status, 429);
  db.sqlite.exec('DELETE FROM comment_log');
  db.fail = (sql) => { if (sql.startsWith('INSERT INTO feature_comments')) throw new Error('storage failure'); };
  assert.equal((await post(env, { id: 1, body: 'Failed write' })).status, 503);
  assert.equal(count(env, 'comment_log'), 0); assert.equal(count(env, 'feature_comments'), 0);
  db.fail = null;
  assert.equal((await post(env, { id: 1, body: 'Recovered write' })).status, 200);
});

test('pagination is bounded and ordered, with pending comments visible only to admins', async (t) => {
  const env = await setup(t);
  const insert = env.DB.sqlite.prepare("INSERT INTO feature_comments (feature_id, body, author, status) VALUES (1, ?, 'visitor', ?)");
  insert.run('Hidden first', 'pending');
  for (let i = 0; i < 52; i++) insert.run(`Approved ${i}`, 'approved');
  const first = await get(env);
  assert.equal(first.body.comments.length, 50); assert.equal(first.body.comments[0].id, 2);
  assert.equal(first.body.nextCursor, 51);
  const last = await get(env, 1, undefined, first.body.nextCursor);
  assert.deepEqual(last.body.comments.map((c) => c.id), [52, 53]); assert.equal(last.body.nextCursor, null);
  const admin = await get(env, 1, 'local-admin');
  assert.equal(admin.body.comments[0].status, 'pending'); assert.equal(admin.body.nextCursor, 50);
  assert.equal((await get(env, 1, undefined, 999)).body.comments.length, 0);
});

test('feature deletion removes comments and response together while retaining the abuse log', async (t) => {
  const env = await setup(t);
  await post(env, { id: 1, body: 'Queued visitor comment' });
  await act(env, { id: 1, action: 'comment', body: 'Maintainer comment' });
  await act(env, { id: 1, action: 'respond', body: 'Pinned response' });
  assert.equal((await act(env, { id: 1, action: 'delete' })).status, 200);
  assert.equal(count(env, 'feature_comments'), 0); assert.equal(count(env, 'feature_responses'), 0);
  assert.equal(count(env, 'comment_log'), 1);
  assert.equal((await get(env)).status, 404);
});
