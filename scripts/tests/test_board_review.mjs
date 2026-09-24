import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ensureSchema } from '../../functions/api/board/_util.js';
import { parseReviewResponse, reviewFeature, reviewPending } from '../../functions/api/board/_review.js';
import { onRequestGet as adminGet } from '../../functions/api/board/admin.js';
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
  const context = { env, waitUntil() {} };
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
  assert.equal(await reviewFeature(context, freshId), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.store, false);
  assert.match(request.instructions, /existing board item covers every part of the request/);
  assert.match(request.instructions, /covers only part of the request, choose human/);
  assert.equal(JSON.parse(request.input).idea.title, 'New feature');
  assert.deepEqual(JSON.parse(request.input).existingBoard, [{ title: 'Existing feature', status: 'open' }]);
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(freshId).first()).status, 'open');
  assert.deepEqual({ ...await db.prepare(`SELECT state, recommendation, reason FROM feature_reviews WHERE feature_id = ?1`)
    .bind(freshId).first() }, { state: 'completed', recommendation: 'approve', reason: 'Relevant media request idea.' });
  assert.equal(await reviewFeature(context, freshId), false);
  assert.equal(calls.length, 1);

  const missed = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Missed idea', '', 'pending')`).run();
  const alsoMissed = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Also missed', '', 'pending')`).run();
  assert.equal(await reviewPending(context), 2);
  assert.equal((await db.prepare(`SELECT state FROM feature_reviews WHERE feature_id = ?1`).bind(missed.meta.last_row_id).first()).state, 'completed');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(missed.meta.last_row_id).first()).status, 'open');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(alsoMissed.meta.last_row_id).first()).status, 'open');

  const failed = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Retry idea', '', 'pending')`).run();
  globalThis.fetch = async () => { calls.push('failed'); return new Response('', { status: 503 }); };
  assert.equal(await reviewFeature(context, failed.meta.last_row_id), false);
  assert.equal((await db.prepare(`SELECT state FROM feature_reviews WHERE feature_id = ?1`).bind(failed.meta.last_row_id).first()).state, 'waiting');
  assert.equal(await reviewPending(context), 0);
  await db.prepare(`UPDATE feature_reviews SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE feature_id = ?1`)
    .bind(failed.meta.last_row_id).run();
  globalThis.fetch = async () => { calls.push('retried'); return modelResponse('human', 'Needs moderator judgment.'); };
  assert.equal(await reviewPending(context), 1);
  assert.equal((await db.prepare(`SELECT recommendation FROM feature_reviews WHERE feature_id = ?1`)
    .bind(failed.meta.last_row_id).first()).recommendation, 'human');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(failed.meta.last_row_id).first()).status, 'pending');

  const declined = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Recipe feature', '', 'pending')`).run();
  globalThis.fetch = async () => modelResponse('decline', 'Recipe planning is outside the app.');
  assert.equal(await reviewFeature(context, declined.meta.last_row_id), true);
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(declined.meta.last_row_id).first()).status, 'declined');

  const concurrent = await db.prepare(`INSERT INTO features (title, detail, status) VALUES ('Concurrent idea', '', 'pending')`).run();
  let concurrentCalls = 0;
  globalThis.fetch = async () => { concurrentCalls += 1; return modelResponse('approve', 'In scope.'); };
  assert.deepEqual((await Promise.all([
    reviewFeature(context, concurrent.meta.last_row_id),
    reviewFeature(context, concurrent.meta.last_row_id),
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
  const inFlight = reviewFeature(context, overridden.meta.last_row_id);
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

  env.NTFY_TOPIC = 'test-topic';
  env.NTFY_URL = 'https://ntfy.example.test';
  env.NTFY_TOKEN = 'test-ntfy-token';
  const notices = [];
  const tasks = [];
  const notifyingContext = { env, waitUntil(promise) { tasks.push(promise); } };
  const drain = async () => {
    while (tasks.length) await Promise.all(tasks.splice(0));
  };
  let recommendation = 'approve';
  globalThis.fetch = async (url, options) => {
    if (url === env.NTFY_URL) {
      assert.equal(options.headers.authorization, 'Bearer test-ntfy-token');
      notices.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return modelResponse(recommendation, `${recommendation} reason`);
  };

  const approved = await db.prepare(`INSERT INTO features (title, detail) VALUES ('Approve notice', '')`).run();
  assert.equal(await reviewFeature(notifyingContext, approved.meta.last_row_id), true);
  await drain();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Cantinarr roadmap: Approved');
  assert.equal(notices[0].message, 'Approve notice\n\napprove reason');
  assert.equal(await reviewFeature(notifyingContext, approved.meta.last_row_id), false);
  await drain();
  assert.equal(notices.length, 1);

  recommendation = 'decline';
  const denied = await db.prepare(`INSERT INTO features (title, detail) VALUES ('Deny notice', '')`).run();
  assert.equal(await reviewFeature(notifyingContext, denied.meta.last_row_id), true);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Denied');
  assert.equal(notices.at(-1).message, 'Deny notice\n\ndecline reason');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(denied.meta.last_row_id).first()).status, 'declined');

  recommendation = 'human';
  const uncertain = await db.prepare(`INSERT INTO features (title, detail) VALUES ('Uncertain notice', '')`).run();
  assert.equal(await reviewFeature(notifyingContext, uncertain.meta.last_row_id), true);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Needs review');

  recommendation = 'approve';
  const backlog = await db.prepare(`INSERT INTO features (title, detail) VALUES ('Backlog notice', '')`).run();
  assert.equal(await reviewPending(notifyingContext), 1);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Approved');
  assert.equal(notices.at(-1).message, 'Backlog notice\n\napprove reason');
  assert.equal((await db.prepare(`SELECT status FROM features WHERE id = ?1`).bind(backlog.meta.last_row_id).first()).status, 'open');

  let releaseSubmissionReview;
  globalThis.fetch = async (url, options) => {
    if (url === env.NTFY_URL) {
      notices.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    }
    return new Promise((resolve) => {
      releaseSubmissionReview = () => resolve(modelResponse('approve', 'Fits the roadmap.'));
    });
  };
  const beforeSubmission = notices.length;
  assert.equal((await submit({
    ...notifyingContext,
    request: new Request('http://localhost/api/board/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New idea notification' }),
    }),
  })).status, 200);
  while (!releaseSubmissionReview) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, beforeSubmission);
  releaseSubmissionReview();
  await drain();
  assert.equal(notices.length, beforeSubmission + 1);
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Approved');

  const manual = await db.prepare(`INSERT INTO features (title, detail) VALUES ('Manual override notice', '')`).run();
  let releaseModel;
  globalThis.fetch = async (url, options) => {
    if (url === env.NTFY_URL) {
      notices.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    }
    return new Promise((resolve) => { releaseModel = () => resolve(modelResponse('approve', 'In scope.')); });
  };
  const noticeCount = notices.length;
  const manualReview = reviewFeature(notifyingContext, manual.meta.last_row_id);
  while (!releaseModel) await new Promise((resolve) => setImmediate(resolve));
  await db.prepare(`UPDATE features SET status = 'planned' WHERE id = ?1`).bind(manual.meta.last_row_id).run();
  releaseModel();
  assert.equal(await manualReview, true);
  await drain();
  assert.equal(notices.length, noticeCount);

  globalThis.fetch = async (url, options) => {
    if (url === env.NTFY_URL) {
      notices.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    }
    return new Response('', { status: 503 });
  };
  const failedSubmit = await submit({
    ...notifyingContext,
    request: new Request('http://localhost/api/board/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Retry notification idea' }),
    }),
  });
  assert.equal(failedSubmit.status, 200);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Review pending');
  const retry = await db.prepare(`SELECT id, status FROM features WHERE title = 'Retry notification idea'`).first();
  assert.equal(retry.status, 'pending');
  await db.prepare(`UPDATE feature_reviews SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE feature_id = ?1`)
    .bind(retry.id).run();
  recommendation = 'decline';
  globalThis.fetch = async (url, options) => {
    if (url === env.NTFY_URL) {
      notices.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    }
    return modelResponse(recommendation, 'Outside scope.');
  };
  assert.equal(await reviewPending(notifyingContext), 1);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Denied');

  const withoutAI = { ...notifyingContext, env: { ...env, OPENAI_API_KEY: '' },
    request: new Request('http://localhost/api/board/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Manual review notification' }),
    }) };
  assert.equal((await submit(withoutAI)).status, 200);
  await drain();
  assert.equal(notices.at(-1).title, 'Cantinarr roadmap: Needs review');

  const adminResponse = await adminGet({
    request: new Request('http://localhost/api/board/admin', {
      headers: { authorization: 'Bearer test-admin-token' },
    }),
    env: { ...env, OPENAI_API_KEY: '', ADMIN_TOKEN: 'test-admin-token' },
  });
  assert.equal(adminResponse.status, 200);
  const adminFeatures = (await adminResponse.json()).features;
  assert.equal(adminFeatures.find((f) => f.title === 'Existing feature').reviewState, null);
  assert.equal(adminFeatures.find((f) => f.title === 'Manual review notification').reviewState, 'awaiting');
});

test('invalid or incomplete model output is rejected', () => {
  assert.throws(() => parseReviewResponse({ status: 'incomplete', output: [] }), /incomplete_response/);
  assert.throws(() => parseReviewResponse({ status: 'completed', output: [] }), /missing_review/);
  assert.throws(() => parseReviewResponse({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: '{"recommendation":"approve","reason":""}' }] },
  ] }), /empty_review_reason/);
});
