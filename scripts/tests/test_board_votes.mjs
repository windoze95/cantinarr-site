import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureSchema, ipHash } from '../../functions/api/board/_util.js';
import { onRequestPost as votePost } from '../../functions/api/board/vote.js';
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
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    // Match D1's serialized transaction, including SELECT results and rollback.
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const uid = '11111111-1111-4111-8111-111111111111';
const uid2 = '22222222-2222-4222-8222-222222222222';
function request(body, voter = uid) {
  return new Request('https://example.test/api/board/vote', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: voter ? `cb_uid=${voter}` : '' },
    body: JSON.stringify(body),
  });
}
async function setup(t) {
  const db = new D1(); t.after(() => db.sqlite.close());
  await ensureSchema(db);
  db.sqlite.exec("INSERT INTO features (id, title, status) VALUES (1, 'Test idea', 'open'), (2, 'Planned idea', 'planned'), (3, 'Done idea', 'shipped'), (4, 'Pending idea', 'pending')");
  return { DB: db, ADMIN_TOKEN: 'local-test-admin' };
}
async function cast(env, body, voter = uid) {
  const response = await votePost({ request: request(body, voter), env });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function list(env, voter = uid) {
  const response = await boardGet({ request: new Request('https://example.test/api/board', {
    headers: { cookie: voter ? `cb_uid=${voter}` : '' },
  }), env });
  return { body: await response.json(), headers: response.headers };
}
function totals(result, up, down, selected) {
  assert.equal(result.status, 200);
  assert.equal(result.body.upvotes, up); assert.equal(result.body.downvotes, down);
  assert.equal(result.body.vote, selected);
  assert.equal(result.body.votes, up); assert.equal(result.body.voted, selected === 'up');
}

test('legacy upgrade preserves voter identity, IP, timestamp, and all upvotes', async (t) => {
  const db = new D1(); t.after(() => db.sqlite.close());
  db.sqlite.exec(`CREATE TABLE votes (feature_id INTEGER NOT NULL, voter_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT 'old', PRIMARY KEY (feature_id, voter_id));
    INSERT INTO votes VALUES (1, '${uid}', 'original-hash', '2026-01-01T00:00:00Z')`);
  await Promise.all([ensureSchema(db), ensureSchema(db), ensureSchema(db)]);
  assert.deepEqual({ ...db.sqlite.prepare('SELECT * FROM votes').get() }, {
    feature_id: 1, voter_id: uid, ip_hash: 'original-hash', created_at: '2026-01-01T00:00:00Z', direction: 'up',
  });
  db.sqlite.exec("INSERT INTO features (id, title, status) VALUES (1, 'Old idea', 'open')");
  const env = { DB: db };
  assert.equal((await list(env)).body.features[0].vote, 'up');
  totals(await cast(env, { id: 1, vote: 'down' }), 0, 1, 'down');
  const row = db.sqlite.prepare('SELECT * FROM votes').get();
  assert.equal(row.ip_hash, 'original-hash'); assert.equal(row.created_at, '2026-01-01T00:00:00Z');
  await ensureSchema(db);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
});

test('schema failures retry and independent bindings initialize', async (t) => {
  const db = new D1(); const other = new D1(); t.after(() => { db.sqlite.close(); other.sqlite.close(); });
  db.fail = () => { throw new Error('temporary failure'); };
  await assert.rejects(ensureSchema(db), /temporary failure/);
  db.fail = null; await ensureSchema(db); await ensureSchema(other);
  assert.ok(other.sqlite.prepare('PRAGMA table_info(votes)').all().some((column) => column.name === 'direction'));
  assert.throws(() => other.sqlite.exec("INSERT INTO votes (feature_id, voter_id, direction) VALUES (1, 'bad', 'sideways')"), /CHECK/);
});

test('simultaneous isolate upgrades tolerate only an actually added column', async (t) => {
  for (const completedElsewhere of [true, false]) {
    const db = new D1(); t.after(() => db.sqlite.close());
    db.sqlite.exec("CREATE TABLE votes (feature_id INTEGER, voter_id TEXT, ip_hash TEXT, created_at TEXT, PRIMARY KEY (feature_id, voter_id))");
    db.fail = (sql) => {
      if (!sql.startsWith('ALTER')) return;
      db.fail = null;
      if (completedElsewhere) db.sqlite.exec(sql);
      throw new Error('concurrent upgrade');
    };
    if (completedElsewhere) await ensureSchema(db);
    else { await assert.rejects(ensureSchema(db), /concurrent upgrade/); await ensureSchema(db); }
  }
});

test('set, repeat, switch, remove, reload, second voter and admin show independent totals', async (t) => {
  const env = await setup(t);
  totals(await cast(env, { id: 1, vote: 'up' }), 1, 0, 'up');
  totals(await cast(env, { id: 1, vote: 'up' }), 1, 0, 'up');
  totals(await cast(env, { id: 1, vote: 'down' }, uid2), 1, 1, 'down');
  totals(await cast(env, { id: 1, vote: 'down' }), 0, 2, 'down');
  totals(await cast(env, { id: 1, vote: 'down' }), 0, 2, 'down');
  let item = (await list(env)).body.features.find((f) => f.id === 1);
  assert.deepEqual([item.upvotes, item.downvotes, item.vote, item.votes, item.voted], [0, 2, 'down', 0, false]);
  totals(await cast(env, { id: 1, vote: null }), 0, 1, null);
  totals(await cast(env, { id: 1, vote: null }), 0, 1, null);
  totals(await cast(env, { id: 2, vote: 'up' }), 1, 0, 'up');
  const admin = await adminGet({ request: new Request('https://example.test/api/board/admin', {
    headers: { authorization: 'Bearer local-test-admin' },
  }), env });
  item = (await admin.json()).features.find((f) => f.id === 1);
  assert.deepEqual([item.upvotes, item.downvotes, item.votes], [0, 1, 0]);
  assert.equal((await list(env)).body.features[0].id, 2, 'ranking still uses upvotes');
});

test('concurrent retries and opposing votes keep one row and consistent transaction snapshots', async (t) => {
  const env = await setup(t);
  const repeats = await Promise.all(Array.from({ length: 12 }, () => cast(env, { id: 1, vote: 'up' })));
  repeats.forEach((result) => totals(result, 1, 0, 'up'));
  const opposing = await Promise.all(['down', 'up', 'down', 'up'].map((vote) => cast(env, { id: 1, vote })));
  opposing.forEach((result, i) => totals(result, i % 2 ? 1 : 0, i % 2 ? 0 : 1, i % 2 ? 'up' : 'down'));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
  (await Promise.all([cast(env, { id: 1, vote: null }), cast(env, { id: 1, vote: null })]))
    .forEach((result) => totals(result, 0, 0, null));
});

test('rate limit is atomic for insert races, while switching/removing existing votes stays allowed', async (t) => {
  const env = await setup(t); const db = env.DB;
  const hash = await ipHash(request({}), env);
  const insert = db.sqlite.prepare("INSERT INTO votes (feature_id, voter_id, ip_hash) VALUES (1, ?, ?)");
  for (let i = 0; i < 39; i++) insert.run(`seed-${i}`, hash);
  const racers = await Promise.all([cast(env, { id: 1, vote: 'up' }), cast(env, { id: 1, vote: 'down' }, uid2)]);
  assert.deepEqual(racers.map((r) => r.status).sort(), [200, 429]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 40);
  assert.equal((await cast(env, { id: 2, vote: 'up' })).status, 429);
  totals(await cast(env, { id: 1, vote: 'down' }), 39, 1, 'down');
  totals(await cast(env, { id: 1, vote: null }), 39, 0, null);
});

test('legacy upvote toggles and compatibility aliases never count downvotes', async (t) => {
  const env = await setup(t);
  totals(await cast(env, { id: 1 }), 1, 0, 'up');
  totals(await cast(env, { id: 1 }), 0, 0, null);
  totals(await cast(env, { id: 1, vote: 'down' }), 0, 1, 'down');
  totals(await cast(env, { id: 1 }), 1, 0, 'up');
});

test('invalid inputs, private/shipped/unknown items and missing DB reject without writes', async (t) => {
  const env = await setup(t);
  for (const body of [null, {}, { id: -1 }, { id: 1.5 }, { id: '1' }, { id: 1, vote: true },
    { id: 1, vote: 1 }, { id: 1, vote: 'sideways' }, { id: Number.MAX_SAFE_INTEGER + 1, vote: 'up' }]) {
    assert.equal((await cast(env, body)).status, 400);
  }
  for (const id of [3, 4, 999]) {
    for (const vote of ['up', 'down', null]) assert.equal((await cast(env, { id, vote })).status, 404);
  }
  assert.equal((await cast({}, { id: 1, vote: 'up' })).status, 503);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
});

test('anonymous identity is established by GET and retained; invalid cookie is replaced securely', async (t) => {
  const env = await setup(t);
  const fresh = await list(env, null); const cookie = fresh.headers.get('set-cookie');
  assert.match(cookie, /^cb_uid=[0-9a-f-]+;.*Secure; HttpOnly; SameSite=Lax$/);
  const voter = cookie.split(';')[0].split('=')[1];
  assert.equal((await list(env, voter)).headers.get('set-cookie'), null);
  totals(await cast(env, { id: 1, vote: 'down' }, voter), 0, 1, 'down');
  assert.equal((await list(env, voter)).body.features[0].vote, 'down');
  assert.match((await cast(env, { id: 2, vote: 'up' }, 'invalid')).headers.get('set-cookie'), /^cb_uid=/);
});

test('failed snapshot rolls back vote mutation; retries recover without inflated counts', async (t) => {
  const env = await setup(t); const db = env.DB;
  totals(await cast(env, { id: 1, vote: 'up' }), 1, 0, 'up');
  db.fail = (sql) => { if (sql.startsWith('SELECT f.status')) throw new Error('storage failure'); };
  const failed = await cast(env, { id: 1, vote: 'down' });
  assert.equal(failed.status, 503); assert.equal(failed.body.error, 'vote_unavailable');
  assert.equal(db.sqlite.prepare('SELECT direction FROM votes').get().direction, 'up');
  db.fail = null;
  totals(await cast(env, { id: 1, vote: 'down' }), 0, 1, 'down');
});

test('moderation retains directional votes when shipped and deletes both directions together', async (t) => {
  const env = await setup(t);
  await cast(env, { id: 1, vote: 'up' }); await cast(env, { id: 1, vote: 'down' }, uid2);
  const act = (action) => adminPost({ env, request: new Request('https://example.test/api/board/admin', {
    method: 'POST', headers: { authorization: 'Bearer local-test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, action }),
  }) });
  assert.equal((await act('shipped')).status, 200);
  assert.equal((await cast(env, { id: 1, vote: null })).status, 404);
  const item = (await list(env)).body.features.find((f) => f.id === 1);
  assert.deepEqual([item.upvotes, item.downvotes], [1, 1]);
  assert.equal((await act('delete')).status, 200);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
});

test('a status change before the write guard rejects the vote without creating an orphan', async (t) => {
  const env = await setup(t); const db = env.DB;
  db.fail = (sql) => {
    if (!sql.startsWith('INSERT INTO votes')) return;
    db.fail = null;
    db.sqlite.exec("UPDATE features SET status = 'shipped' WHERE id = 1");
  };
  assert.equal((await cast(env, { id: 1, vote: 'down' })).status, 404);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
});
