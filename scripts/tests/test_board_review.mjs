import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ensureSchema } from '../../functions/api/board/_util.js';
import { parseReviewResponse, reviewFeature, reviewPending } from '../../functions/api/board/_review.js';
import { onRequestPost as submit } from '../../functions/api/board/submit.js';

class D1Statement {
  constructor(sqlite, sql, values = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) { return new D1Statement(this.sqlite, this.sql, values); }
  async first() { return this.sqlite.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

function modelResponse(recommendation, reason) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ recommendation, reason }) }] }],
  }), { status: 200 });
}

test('Luna moderates new and missed ideas once, and retries failures', async (t) => {
  const db = new D1();
  await ensureSchema(db);
  const env = { DB: db, OPENAI_API_KEY: 'test-key' };
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; db.sqlite.close(); });
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return modelResponse('approve', 'Relevant media request idea.');
  };

  await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Existing feature', '', 'open')`).run();
  const fresh = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('New feature', 'A useful option', 'pending')`).run();
  const freshId = fresh.meta.last_row_id;
  assert.equal(await reviewFeature(env, freshId), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.store, false);
  assert.equal(JSON.parse(request.input).idea.title, 'New feature');
  assert.deepEqual(JSON.parse(request.input).existingBoard, [{ title: 'Existing feature', status: 'open' }]);
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(freshId).first()).status, 'open');
  assert.deepEqual({ ...await db.prepare(`SELECT state, recommendation, reason FROM feature_reviews WHERE feature_id = ?1`)
    .bind(freshId).first() }, { state: 'completed', recommendation: 'approve', reason: 'Relevant media request idea.' });
  assert.equal(await reviewFeature(env, freshId), false);
  assert.equal(calls.length, 1);

  const missed = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Missed idea', '', 'pending')`).run();
  assert.equal(await reviewPending(env), 1);
  assert.equal((await db.prepare(`SELECT state FROM feature_reviews WHERE feature_id = ?1`).bind(missed.meta.last_row_id).first()).state, 'completed');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(missed.meta.last_row_id).first()).status, 'open');

  const failed = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Retry idea', '', 'pending')`).run();
  globalThis.fetch = async () => { calls.push('failed'); return new Response('', { status: 503 }); };
  assert.equal(await reviewFeature(env, failed.meta.last_row_id), false);
  assert.equal((await db.prepare(`SELECT state FROM feature_reviews WHERE feature_id = ?1`).bind(failed.meta.last_row_id).first()).state, 'waiting');
  assert.equal(await reviewPending(env), 0);
  await db.prepare(`UPDATE feature_reviews SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE feature_id = ?1`)
    .bind(failed.meta.last_row_id).run();
  globalThis.fetch = async () => { calls.push('retried'); return modelResponse('human', 'Needs moderator judgment.'); };
  assert.equal(await reviewPending(env), 1);
  assert.equal((await db.prepare(`SELECT recommendation FROM feature_reviews WHERE feature_id = ?1`)
    .bind(failed.meta.last_row_id).first()).recommendation, 'human');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(failed.meta.last_row_id).first()).status, 'pending');

  const declined = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Recipe feature', '', 'pending')`).run();
  globalThis.fetch = async () => modelResponse('decline', 'Recipe planning is outside the app.');
  assert.equal(await reviewFeature(env, declined.meta.last_row_id), true);
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(declined.meta.last_row_id).first()).status, 'declined');

  const concurrent = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Concurrent idea', '', 'pending')`).run();
  let concurrentCalls = 0;
  globalThis.fetch = async () => { concurrentCalls += 1; return modelResponse('approve', 'In scope.'); };
  assert.deepEqual((await Promise.all([
    reviewFeature(env, concurrent.meta.last_row_id),
    reviewFeature(env, concurrent.meta.last_row_id),
  ])).sort(), [false, true]);
  assert.equal(concurrentCalls, 1);

  const overridden = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Manual decision', '', 'pending')`).run();
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  let finish;
  globalThis.fetch = () => {
    started();
    return new Promise((resolve) => { finish = () => resolve(modelResponse('approve', 'In scope.')); });
  };
  const inFlight = reviewFeature(env, overridden.meta.last_row_id);
  await fetching;
  await db.prepare(`UPDATE features SET status = 'planned' WHERE id = ?1`).bind(overridden.meta.last_row_id).run();
  finish();
  assert.equal(await inFlight, true);
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(overridden.meta.last_row_id).first()).status, 'planned');

  globalThis.fetch = async () => modelResponse('approve', 'In scope.');

  const background = [];
  const submission = await submit({
    request: new Request('http://localhost/api/board/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Submitted idea', detail: 'Review on arrival' }),
    }),
    env,
    waitUntil(promise) { background.push(promise); },
  });
  assert.equal(submission.status, 200);
  await Promise.all(background);
  const submitted = await db.prepare(`SELECT f.status, r.state FROM features f JOIN feature_reviews r ON r.feature_id = f.id WHERE f.title = 'Submitted idea'`).first();
  assert.equal(submitted.status, 'open');
  assert.equal(submitted.state, 'completed');
});

test('invalid or incomplete model output is rejected', () => {
  assert.throws(() => parseReviewResponse({ status: 'incomplete', output: [] }), /incomplete_response/);
  assert.throws(() => parseReviewResponse({ status: 'completed', output: [] }), /missing_review/);
  assert.throws(() => parseReviewResponse({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: '{"recommendation":"approve","reason":""}' }] },
  ] }), /empty_review_reason/);
});
