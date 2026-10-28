import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureSchema } from '../../functions/api/board/_util.js';
import { reviewPending } from '../../functions/api/board/_review.js';
import { onRequestPost as submit } from '../../functions/api/board/submit.js';
import { onRequestGet as boardGet } from '../../functions/api/board/index.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../../functions/api/board/admin.js';
import { onRequestGet as commentsGet } from '../../functions/api/board/comments.js';
import { onRequestPost as votePost } from '../../functions/api/board/vote.js';

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

let requestNumber = 0;
function request(path, body, token) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${++requestNumber}` };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(`https://example.test/api/board${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function backgroundContext(env) {
  const tasks = [];
  return {
    env,
    waitUntil(promise) { tasks.push(promise); },
    async drain() { while (tasks.length) await Promise.all(tasks.splice(0)); },
  };
}
async function invoke(handler, env, req) {
  const context = backgroundContext(env);
  const response = await handler({ ...context, request: req });
  await context.drain();
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const post = (env, body) => invoke(submit, env, request('/submit', { title: 'Useful feature idea', ...body }));
const act = (env, id, action) => invoke(adminPost, env, request('/admin', { id, action }, 'local-admin'));
const admin = (env, token = 'local-admin') => invoke(adminGet, env, request('/admin', undefined, token));
const count = (env, table) => env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
async function setup(t) {
  const db = new D1();
  t.after(() => db.sqlite.close());
  await ensureSchema(db);
  return { DB: db, ADMIN_TOKEN: 'local-admin', VOTE_SALT: 'test-salt' };
}
const privateEmail = 'private-contact-sentinel@example.test';
const privateDiscord = 'private_discord_sentinel#1234';
function assertNoContact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [privateEmail, privateDiscord]) assert.ok(!text.includes(secret), 'contact value escaped its admin-only boundary');
  assert.ok(!/contactEmail|contactDiscord|contact_email|contact_discord/.test(text), 'contact properties escaped their admin-only boundary');
}

test('contact schema upgrades existing features and old votes without creating contact data', async (t) => {
  const db = new D1();
  t.after(() => db.sqlite.close());
  db.sqlite.exec(`CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT 'old');
    CREATE TABLE votes (feature_id INTEGER NOT NULL, voter_id TEXT NOT NULL, ip_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT 'old', PRIMARY KEY (feature_id, voter_id));
    INSERT INTO features VALUES (7, 'Existing idea', 'Original detail', 'open', 'original-date');
    INSERT INTO votes VALUES (7, 'old-voter', 'original-hash', 'original-date')`);
  await Promise.all([ensureSchema(db), ensureSchema(db)]);
  const env = { DB: db, ADMIN_TOKEN: 'local-admin' };
  const feature = (await admin(env)).body.features[0];
  assert.equal(feature.title, 'Existing idea');
  assert.equal(feature.detail, 'Original detail');
  assert.equal(feature.createdAt, 'original-date');
  assert.equal(feature.upvotes, 1);
  assert.equal(feature.contactEmail, '');
  assert.equal(feature.contactDiscord, '');
  assert.equal(count(env, 'feature_contacts'), 0);
  assert.equal(db.sqlite.prepare('SELECT direction FROM votes').get().direction, 'up');
  assert.equal((await post(env, { contactEmail: privateEmail })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT feature_id FROM feature_contacts').get().feature_id, 8);
});

test('contacts are optional, trimmed, and attached to the correct submission', async (t) => {
  const env = await setup(t);
  const cases = [
    [{}, '', ''],
    [{ contactEmail: null, contactDiscord: null }, '', ''],
    [{ contactEmail: '   ', contactDiscord: '  ' }, '', ''],
    [{ contactEmail: `  ${privateEmail}  ` }, privateEmail, ''],
    [{ contactDiscord: `  ${privateDiscord}  ` }, '', privateDiscord],
    [{ contactEmail: privateEmail, contactDiscord: privateDiscord }, privateEmail, privateDiscord],
    [{ contactEmail: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, contactDiscord: 'd'.repeat(100) },
      `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, 'd'.repeat(100)],
    [{ contactDiscord: '@Display Name#1234' }, '', '@Display Name#1234'],
  ];
  for (const [fields, email, discord] of cases) {
    const title = `Optional contact case ${count(env, 'features')}`;
    const result = await post(env, { title, ...fields });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, queued: true });
    const feature = (await admin(env)).body.features.find((item) => item.title === title);
    assert.equal(feature.contactEmail, email);
    assert.equal(feature.contactDiscord, discord);
    const row = env.DB.sqlite.prepare('SELECT email, discord FROM feature_contacts WHERE feature_id = ?').get(feature.id);
    if (email || discord) assert.deepEqual({ ...row }, { email, discord });
    else assert.equal(row, undefined, 'blank contacts should not create a private row');
  }
  assert.equal(count(env, 'features'), cases.length);
  assert.equal(count(env, 'submission_log'), cases.length);
  assert.equal(count(env, 'feature_contacts'), 5);
});

test('invalid contact data is rejected without truncating, reflecting, or storing it', async (t) => {
  const env = await setup(t);
  const invalidEmail = [true, 123, {}, [], 'missing-at.example.test', 'two@@example.test',
    'person@', '@example.test', 'person@localhost', 'person@.example.test', 'person@example..test',
    'person@example.test.', 'first last@example.test', '<person@example.test>', 'person@exam ple.test',
    'person\n@example.test', 'person\t@example.test', 'person\u0000@example.test', 'person\u007f@example.test',
    `${'a'.repeat(243)}@example.test`];
  const invalidDiscord = [true, 123, {}, [], 'd'.repeat(101), 'hello\nworld', 'hello\rworld',
    'hello\tworld', 'hello\u0000world', 'hello\u007fworld'];
  for (const [key, error, values] of [
    ['contactEmail', 'invalid_contact_email', invalidEmail],
    ['contactDiscord', 'invalid_contact_discord', invalidDiscord],
  ]) {
    for (const value of values) {
      const result = await post(env, { [key]: value });
      assert.equal(result.status, 400, `${key}: ${JSON.stringify(value)}`);
      assert.deepEqual(result.body, { error });
    }
  }
  for (const table of ['features', 'feature_contacts', 'submission_log']) assert.equal(count(env, table), 0);
  assert.deepEqual((await post(env, { website: 'bot trap', contactEmail: privateEmail, contactDiscord: privateDiscord })).body,
    { ok: true, queued: true });
  assert.equal(count(env, 'feature_contacts'), 0);
});

test('only authenticated admin reads expose contacts across all roadmap statuses', async (t) => {
  const env = await setup(t);
  assertNoContact((await post(env, { contactEmail: privateEmail, contactDiscord: privateDiscord })).body);
  const id = env.DB.sqlite.prepare('SELECT id FROM features').get().id;
  for (const token of [undefined, 'wrong-token']) {
    const denied = await invoke(adminGet, env, request('/admin', undefined, token));
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: 'unauthorized' });
    assertNoContact(denied.body);
  }
  for (const action of [null, 'approve', 'planned', 'shipped', 'decline']) {
    if (action) assertNoContact((await act(env, id, action)).body);
    const privateBoard = await admin(env);
    assert.equal(privateBoard.headers.get('cache-control'), 'no-store');
    assert.equal(privateBoard.body.features[0].contactEmail, privateEmail);
    assert.equal(privateBoard.body.features[0].contactDiscord, privateDiscord);
    const publicBoard = await invoke(boardGet, env, request(''));
    assertNoContact(publicBoard.body);
    assert.equal(publicBoard.body.features.length, [null, 'decline'].includes(action) ? 0 : 1);
    assertNoContact((await invoke(commentsGet, env, request(`/comments?id=${id}`))).body);
    assertNoContact((await invoke(votePost, env, request('/vote', { id, vote: 'up' }))).body);
  }
});

test('AI requests and notifications exclude contacts on submission, failures, and retries', async (t) => {
  const env = await setup(t);
  Object.assign(env, { OPENAI_API_KEY: 'test-key', NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example.test' });
  const outbound = [];
  const errors = [];
  let failModel = false;
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });
  console.error = (...values) => errors.push(values.join(' '));
  globalThis.fetch = async (url, options) => {
    outbound.push({ url, payload: JSON.parse(options.body) });
    if (url === env.NTFY_URL) return new Response('', { status: 200 });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    if (failModel) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{
      type: 'output_text', text: JSON.stringify({ recommendation: 'approve', reason: 'Fits the roadmap.' }),
    }] }] }));
  };
  assert.equal((await post(env, { title: 'First private contact', contactEmail: privateEmail, contactDiscord: privateDiscord })).status, 200);
  assert.equal(outbound.filter((call) => call.url === env.NTFY_URL).length, 1);
  failModel = true;
  assert.equal((await post(env, { title: 'Retry private contact', contactEmail: privateEmail, contactDiscord: privateDiscord })).status, 200);
  assert.equal(outbound.at(-1).payload.title, 'Cantinarr roadmap: Review pending');
  env.DB.sqlite.exec("UPDATE feature_reviews SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE state = 'waiting'");
  failModel = false;
  const context = backgroundContext(env);
  assert.equal(await reviewPending(context), 1);
  await context.drain();
  assert.equal(outbound.at(-1).payload.title, 'Cantinarr roadmap: Approved');
  const modelCalls = outbound.filter((call) => call.url !== env.NTFY_URL);
  assert.equal(modelCalls.length, 3);
  assert.deepEqual(JSON.parse(modelCalls.at(-1).payload.input).existingBoard, [{ title: 'First private contact', status: 'open' }]);
  for (const call of modelCalls) assert.deepEqual(Object.keys(JSON.parse(call.payload.input).idea).sort(), ['detail', 'title']);
  delete env.OPENAI_API_KEY;
  assert.equal((await post(env, { title: 'Manual private contact', contactEmail: privateEmail, contactDiscord: privateDiscord })).status, 200);
  assert.equal(outbound.at(-1).payload.title, 'Cantinarr roadmap: Needs review');
  assertNoContact(outbound);
  assertNoContact(errors);
  assert.equal(count(env, 'feature_contacts'), 3);
});

test('submission transaction rolls back feature, contact and rate-limit rows on either write failure', async (t) => {
  const env = await setup(t);
  for (const failingTable of ['feature_contacts', 'submission_log']) {
    env.DB.fail = (sql) => {
      if (sql.includes(`INSERT INTO ${failingTable}`)) throw new Error('simulated database write failure');
    };
    await assert.rejects(post(env, { contactEmail: privateEmail, contactDiscord: privateDiscord }), /simulated database write failure/);
    for (const table of ['features', 'feature_contacts', 'submission_log']) assert.equal(count(env, table), 0);
  }
  delete env.DB.fail;
  assert.equal((await post(env, { contactEmail: privateEmail, contactDiscord: privateDiscord })).status, 200);
  assert.equal(count(env, 'features'), 1);
  assert.equal(count(env, 'feature_contacts'), 1);
});

test('deleting an item removes its private contacts without touching other submissions', async (t) => {
  const env = await setup(t);
  await post(env, { title: 'Delete this contact', contactEmail: privateEmail, contactDiscord: privateDiscord });
  await post(env, { title: 'Keep this contact', contactEmail: 'keep@example.test' });
  const deleted = env.DB.sqlite.prepare("SELECT id FROM features WHERE title = 'Delete this contact'").get().id;
  const kept = env.DB.sqlite.prepare("SELECT id FROM features WHERE title = 'Keep this contact'").get().id;
  // The handler explicitly cleans up dependents, even without SQLite's FK helper.
  env.DB.sqlite.exec('PRAGMA foreign_keys=OFF');
  assert.deepEqual((await act(env, deleted, 'delete')).body, { ok: true, deleted: true });
  assert.equal(env.DB.sqlite.prepare('SELECT * FROM feature_contacts WHERE feature_id = ?').get(deleted), undefined);
  assert.equal(count(env, 'feature_contacts'), 1);
  assert.equal(env.DB.sqlite.prepare('SELECT email FROM feature_contacts WHERE feature_id = ?').get(kept).email, 'keep@example.test');
});
