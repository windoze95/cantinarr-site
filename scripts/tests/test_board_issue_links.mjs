import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureSchema } from '../../functions/api/board/_util.js';
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

test('issue link can be added, replaced and cleared independently of discussions and votes', async (t) => {
  const env = await setup(t);
  await act(env, { id: 1, action: 'respond', body: 'Pinned response' });
  await act(env, { id: 1, action: 'comment', body: 'Maintainer comment' });
  env.DB.sqlite.exec("INSERT INTO votes (feature_id, voter_id, direction) VALUES (1, 'visitor', 'down')");
  const read = async () => (await invoke(boardGet, env, request(''))).body.features.find((f) => f.id === 1);
  assert.equal((await read()).githubIssueUrl, '');
  const url = 'https://github.com/windoze95/cantinarr/issues/677';
  const saved = await act(env, { id: 1, action: 'link_issue', url: '  ' + url + '/?view=all#issuecomment-123  ' });
  assert.deepEqual(saved.body, { ok: true, githubIssueUrl: url });
  assert.equal((await read()).githubIssueUrl, url);
  const admin = await invoke(adminGet, env, request('/admin', undefined, 'local-admin'));
  assert.equal(admin.body.features.find((f) => f.id === 1).githubIssueUrl, url);
  const replacement = 'https://github.com/another-owner/another.repo/issues/42';
  await act(env, { id: 1, action: 'link_issue', url: replacement });
  assert.equal((await read()).githubIssueUrl, replacement);
  assert.equal(count(env, 'feature_issue_links'), 1);
  assert.deepEqual((await act(env, { id: 1, action: 'link_issue', url: '' })).body, { ok: true, githubIssueUrl: '' });
  assert.equal((await read()).githubIssueUrl, '');
  assert.equal(count(env, 'feature_issue_links'), 0);
  assert.equal((await read()).maintainerResponse, 'Pinned response');
  assert.equal((await read()).commentCount, 1);
  assert.equal((await read()).downvotes, 1);
});

test('only authenticated admins can link valid HTTPS GitHub issue URLs', async (t) => {
  const env = await setup(t);
  const url = 'https://github.com/windoze95/cantinarr/issues/677';
  assert.equal((await invoke(adminPost, env, request('/admin', { id: 1, action: 'link_issue', url }))).status, 401);
  assert.equal((await act(env, { id: 1, action: 'link_issue', url }, 'wrong-token')).status, 401);
  await act(env, { id: 1, action: 'link_issue', url });
  for (const invalid of [undefined, null, 677, {}, 'javascript:alert(1)', '//github.com/a/b/issues/1',
    'http://github.com/a/b/issues/1', 'https://github.com.evil.test/a/b/issues/1',
    'https://evil.test/github.com/a/b/issues/1', 'https://github.com@evil.test/a/b/issues/1',
    'https://user:pass@github.com/a/b/issues/1', 'https://github.com:8443/a/b/issues/1',
    'https://github.com/a/b/pull/1', 'https://github.com/a/b/issues',
    'https://github.com/a/b/issues/0', 'https://github.com/a/b/issues/-1',
    'https://github.com/a/b/issues/1/extra', 'https://github.com/a/b/issues/%31', 'x'.repeat(1001)]) {
    const result = await act(env, { id: 1, action: 'link_issue', url: invalid });
    assert.equal(result.status, 400, JSON.stringify(invalid));
    assert.equal(result.body.error, 'invalid_issue_url');
  }
  assert.equal(env.DB.sqlite.prepare('SELECT issue_url FROM feature_issue_links').get().issue_url, url);
  assert.equal((await act(env, { id: 999, action: 'link_issue', url })).status, 404);
});

test('links respect roadmap visibility and are removed with the parent item', async (t) => {
  const env = await setup(t);
  for (const id of [1, 2, 3, 4, 5]) {
    assert.equal((await act(env, { id, action: 'link_issue', url: `https://github.com/a/b/issues/${id}` })).status, 200);
  }
  const board = await invoke(boardGet, env, request(''));
  assert.deepEqual(board.body.features.map((f) => f.id).sort(), [1, 2, 3]);
  assert.ok(board.body.features.every((f) => f.githubIssueUrl.endsWith('/' + f.id)));
  assert.equal(count(env, 'feature_issue_links'), 5);
  await act(env, { id: 1, action: 'delete' });
  assert.equal(count(env, 'feature_issue_links'), 4);
  assert.equal(env.DB.sqlite.prepare('SELECT * FROM feature_issue_links WHERE feature_id = 1').get(), undefined);
});

