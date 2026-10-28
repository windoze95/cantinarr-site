import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../public/roadmap/admin.html', import.meta.url), 'utf8')
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const viewSource = readFileSync(new URL('../../public/static/board-view-v2.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {};
    this.disabled = false; this.hidden = false; this.value = '';
  }
  set textContent(value) { this.text = value; this.children.forEach((child) => { child.parentNode = null; }); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child, before) {
    if (!before) return this.appendChild(child);
    if (child === before) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.splice(this.children.indexOf(before), 0, child); child.parentNode = this; return child;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(event, handler) { this.events[event] = handler; }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  focus() { this.focused = true; }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const walk = (root) => [root, ...root.children.flatMap(walk)];
const byClass = (root, name) => walk(root).find((node) => node.className?.split(' ').includes(name));
const byId = (root, id) => walk(root).find((node) => node.id === id);
const button = (root, text) => walk(root).find((node) => node.tag === 'button' && node.textContent === text);
const submit = (form) => form.events.submit({ preventDefault() {} });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const feature = (id) => ({ id, title: 'Feature ' + id, status: 'open', detail: '', createdAt: '2026-10-27T12:00:00Z',
  upvotes: 1, downvotes: 0, commentCount: 1, pendingCommentCount: 1, maintainerResponse: id === 1 ? '<b>Pinned update</b>' : '' });
const comment = (id, status = 'approved') => ({ id, body: '<img onerror=alert(1)>', author: 'visitor', status, createdAt: '2026-10-27T12:00:00Z' });

async function page() {
  const elements = Object.fromEntries(['token', 'mod-status', 'mod-controls', 'mod-sections', 'load'].map((id) => [id, Object.assign(new Element('div'), { id })]));
  const calls = []; const server = { features: [feature(1), feature(2)], reviewEnabled: false };
  const comments = [comment(1, 'pending'), comment(2)];
  let send = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'respond') server.features.find((f) => f.id === body.id).maintainerResponse = body.body.trim();
    if (body.action === 'planned') server.features.find((f) => f.id === body.id).status = 'planned';
    if (body.action === 'comment') comments.push({ ...comment(3), author: 'maintainer', body: body.body });
    if (body.action === 'approve_comment') comments.find((c) => c.id === body.commentId).status = 'approved';
    if (body.action === 'delete_comment') comments.splice(comments.findIndex((c) => c.id === body.commentId), 1);
    if (body.action === 'link_issue') {
      const url = body.url.trim().split(/[?#]/)[0];
      server.features.find((f) => f.id === body.id).githubIssueUrl = url;
      return response({ ok: true, githubIssueUrl: url });
    }
    return response({ ok: true });
  };
  let read = async (url) => url === '/api/board/admin' ? response(server) : response({ comments, nextCursor: null });
  const context = {
    document: { getElementById: (id) => elements[id] || Object.values(elements).map((node) => byId(node, id)).find(Boolean), createElement: (tag) => new Element(tag), createTextNode: (text) => Object.assign(new Element('text'), { text }) },
    window: { addEventListener() {} },
    sessionStorage: { getItem: () => 'local-test-token', setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    fetch: (url, options) => {
      calls.push({ url, options });
      return options?.method === 'POST' ? send(url, options) : read(url, options);
    },
  };
  vm.runInNewContext(viewSource, context);
  vm.runInNewContext(source, context);
  elements.load.events.click();
  await tick();
  const cards = walk(elements['mod-sections']).filter((node) => node.className === 'mod-item')
    .sort((a, b) => walk(a).find((node) => node.tag === 'textarea').id.localeCompare(walk(b).find((node) => node.tag === 'textarea').id));
  return { elements, calls, server, comments, cards,
    card: (id) => walk(elements['mod-sections']).find((node) => node.className === 'mod-item' && byId(node, 'response-' + id)), setSend: (handler) => { send = handler; }, setRead: (handler) => { read = handler; } };
}

async function openComments(card) {
  const details = byClass(card, 'mod-comments');
  details.open = true; details.events.toggle(); await tick();
  return details;
}

test('admin contact is optional and renders untrusted values as plain text', async () => {
  const p = await page();
  assert.equal(byClass(p.card(1), 'private-contact'), undefined);
  Object.assign(p.server.features[0], { contactEmail: 'visitor@example.test', contactDiscord: '<img src=x onerror=alert(1)>' });
  p.elements.load.events.click(); await tick();
  const contact = byClass(p.card(1), 'private-contact');
  assert.match(contact.textContent, /Admin only/);
  assert.equal(byClass(contact, 'contact-email').textContent, 'Email: visitor@example.test');
  assert.equal(byClass(contact, 'contact-discord').textContent, 'Discord: <img src=x onerror=alert(1)>');
  assert.equal(byClass(contact, 'contact-discord').children.length, 0);
  assert.ok(walk(contact).every((node) => node.tag !== 'a' && node.tag !== 'img'));
  assert.equal(byClass(p.card(2), 'private-contact'), undefined);
});

test('missing and rejected admin credentials clear private cards and stale reads cannot restore them', async () => {
  const p = await page();
  Object.assign(p.server.features[0], { contactEmail: 'visitor@example.test' });
  p.elements.load.events.click(); await tick();
  assert.match(p.elements['mod-sections'].textContent, /visitor@example\.test/);
  let finish;
  p.setRead(() => new Promise((resolve) => { finish = () => resolve(response(p.server)); }));
  p.elements.load.events.click();
  p.elements.token.value = '';
  p.elements.load.events.click();
  assert.equal(p.elements['mod-sections'].textContent, '');
  finish(); await tick();
  assert.equal(p.elements['mod-sections'].textContent, '');
  p.elements.token.value = 'local-test-token';
  p.setRead(async () => response(p.server));
  p.elements.load.events.click(); await tick();
  assert.match(p.elements['mod-sections'].textContent, /visitor@example\.test/);
  p.setRead(async () => response({ error: 'unauthorized' }, 401));
  p.elements.load.events.click(); await tick();
  assert.equal(p.elements['mod-sections'].textContent, '');
  assert.match(p.elements['mod-status'].textContent, /token was rejected/);
});

test('transient admin load errors retain authenticated drafts and cards', async () => {
  const p = await page();
  const card = p.card(1);
  byId(card, 'response-1').value = 'Keep this draft';
  p.setRead(async () => { throw new Error('offline'); });
  p.elements.load.events.click(); await tick();
  assert.equal(p.card(1), card);
  assert.equal(byId(card, 'response-1').value, 'Keep this draft');
  assert.match(p.elements['mod-status'].textContent, /Could not load the board: offline/);
});

test('a stale authentication rejection cannot clear a newer authenticated board', async () => {
  for (const oldToken of ['wrong-token', 'local-test-token']) {
    const p = await page();
    let rejectOld;
    p.setRead(() => new Promise((resolve) => {
      rejectOld = () => resolve(response({ error: 'unauthorized' }, 401));
    }));
    p.elements.token.value = oldToken;
    p.elements.load.events.click();
    p.elements.token.value = 'local-test-token';
    Object.assign(p.server.features[0], { contactEmail: 'visitor@example.test' });
    p.setRead(async () => response(p.server));
    p.elements.load.events.click(); await tick();
    const card = p.card(1);
    assert.match(card.textContent, /visitor@example\.test/);
    rejectOld(); await tick();
    assert.equal(p.card(1), card, 'old rejection must not remove the newer view');
    assert.equal(p.elements['mod-status'].textContent, '');
  }
});

test('admin response stays separate from lazy comments and saving preserves another card draft', async () => {
  const p = await page(); const [card, other] = p.cards;
  assert.equal(p.calls.length, 1, 'comments are not fetched for closed cards');
  const responseForm = byClass(card, 'response-editor');
  const responseInput = byId(card, 'response-1');
  const otherInput = byId(other, 'response-2');
  assert.equal(responseInput.value, '<b>Pinned update</b>');
  assert.equal(responseForm.children[0].attrs.for, 'response-1');
  otherInput.value = 'Unsaved second response';
  responseInput.value = 'New pinned response';
  submit(responseForm); await tick();
  const sent = p.calls.find((call) => call.options?.method === 'POST');
  assert.deepEqual(JSON.parse(sent.options.body), { id: 1, action: 'respond', body: 'New pinned response' });
  assert.match(byClass(responseForm, 'thread-status').textContent, /Response saved on the card/);
  assert.equal(otherInput.value, 'Unsaved second response');
  assert.equal(p.calls.filter((call) => call.url === '/api/board/admin' && !call.options?.method).length, 1, 'save does not rebuild the board');
  button(card, 'Remove response').events.click(); await tick();
  assert.equal(responseInput.value, '');
  assert.equal(button(card, 'Remove response').hidden, true);
  assert.equal(JSON.parse(p.calls.at(-1).options.body).body, '');
});

test('admin thread safely renders pending comments and scopes approve and confirmed delete actions', async () => {
  const p = await page(); const card = p.cards[0];
  const details = await openComments(card);
  const request = p.calls.find((call) => call.url.includes('/comments'));
  assert.equal(request.options.headers.authorization, 'Bearer local-test-token');
  assert.match(details.children[0].textContent, /1 pending/);
  const list = byClass(details, 'comment-list');
  assert.equal(list.children.length, 2);
  assert.equal(byClass(list.children[0], 'comment-body').textContent, '<img onerror=alert(1)>');
  assert.equal(byClass(list.children[0], 'comment-body').children.length, 0, 'content is text, never parsed HTML');
  button(list.children[0], 'Approve comment').events.click(); await tick();
  assert.deepEqual(JSON.parse(p.calls.at(-1).options.body), { id: 1, action: 'approve_comment', commentId: 1 });
  assert.equal(button(list.children[0], 'Approve comment').hidden, true);
  assert.match(details.children[0].textContent, /2 published/);
  const remove = button(list.children[0], 'Delete comment');
  const before = p.calls.length;
  remove.events.click();
  assert.equal(p.calls.length, before, 'first delete tap only asks for confirmation');
  remove.events.click(); await tick();
  assert.deepEqual(JSON.parse(p.calls.at(-1).options.body), { id: 1, action: 'delete_comment', commentId: 1 });
  assert.equal(list.children.length, 1);
});

test('comment pagination appends a page and posting publishes as maintainer without losing other drafts', async () => {
  const p = await page(); const card = p.cards[0];
  p.setRead(async (url) => url.includes('&after=') ? response({ comments: [comment(9)], nextCursor: null })
    : response({ comments: [comment(8)], nextCursor: 8 }));
  const details = await openComments(card);
  const more = button(details, 'Load more comments');
  assert.equal(more.hidden, false);
  more.events.click(); await tick();
  assert.match(p.calls.at(-1).url, /\?id=1&after=8$/);
  assert.equal(byClass(details, 'comment-list').children.length, 2);
  assert.equal(more.hidden, true);
  byId(p.cards[1], 'comment-2').value = 'Other draft';
  const input = byId(card, 'comment-1'); input.value = 'Maintainer discussion';
  submit(byClass(card, 'comment-form')); await tick();
  const sent = p.calls.filter((call) => call.options?.method === 'POST').at(-1);
  assert.deepEqual(JSON.parse(sent.options.body), { id: 1, action: 'comment', body: 'Maintainer discussion' });
  assert.equal(input.value, '');
  assert.equal(byId(p.cards[1], 'comment-2').value, 'Other draft');
  assert.match(byClass(byClass(card, 'comment-form'), 'thread-status').textContent, /published as maintainer/);
});

test('lost comment reply retains the draft, blocks duplicate posts, and requires a manual refresh', async () => {
  const p = await page(); const card = p.cards[0]; await openComments(card);
  const form = byClass(card, 'comment-form'); const input = byId(card, 'comment-1');
  input.value = 'Keep this draft';
  let reject;
  p.setSend(() => new Promise((resolve, fail) => { reject = fail; }));
  submit(form); submit(form);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
  assert.equal(input.disabled, true);
  reject(new Error('lost response')); await tick();
  assert.equal(input.value, 'Keep this draft');
  assert.equal(input.disabled, false);
  assert.equal(button(card, 'Post comment').disabled, true);
  submit(form); await tick();
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1, 'unknown writes never replay automatically');
  assert.match(byClass(form, 'thread-status').textContent, /Refresh comments and check/);
  button(card, 'Refresh comments').events.click(); await tick();
  assert.equal(button(card, 'Post comment').disabled, false);
  assert.match(byClass(form, 'thread-status').textContent, /Check for your comment/);
});

test('known comment rejection and an unconfirmed response save preserve drafts', async () => {
  const p = await page(); const card = p.cards[0]; await openComments(card);
  const form = byClass(card, 'comment-form'); const input = byId(card, 'comment-1'); input.value = 'Still here';
  p.setSend(async () => response({ error: 'unauthorized' }, 401));
  submit(form); await tick();
  assert.equal(input.value, 'Still here'); assert.equal(button(card, 'Post comment').disabled, false);
  assert.match(byClass(form, 'thread-status').textContent, /unauthorized/);
  const responseInput = byId(card, 'response-1'); responseInput.value = 'Unsaved response';
  p.setSend(async () => response({}));
  submit(byClass(card, 'response-editor')); await tick();
  assert.equal(responseInput.value, 'Unsaved response');
  assert.match(byClass(byClass(card, 'response-editor'), 'thread-status').textContent, /Could not confirm the save/);
});


test('status changes and explicit board reloads preserve per-feature drafts and open conversations', async () => {
  const p = await page();
  byId(p.card(1), 'response-1').value = 'Same card response draft';
  byId(p.card(2), 'response-2').value = 'Other card response draft';
  await openComments(p.card(2));
  byId(p.card(2), 'comment-2').value = 'Other card comment draft';
  const previousCard = p.card(2);
  button(p.card(1), 'Planned').events.click(); await tick();
  assert.notEqual(p.card(2), previousCard, 'status changes rebuild the board');
  assert.equal(byId(p.card(1), 'response-1').value, 'Same card response draft');
  assert.equal(byId(p.card(2), 'response-2').value, 'Other card response draft');
  assert.equal(byId(p.card(2), 'comment-2').value, 'Other card comment draft');
  assert.equal(byClass(p.card(2), 'mod-comments').open, true);
  p.elements.load.events.click(); await tick();
  assert.equal(byId(p.card(2), 'response-2').value, 'Other card response draft');
  assert.equal(byId(p.card(2), 'comment-2').value, 'Other card comment draft');
  submit(byClass(p.card(2), 'response-editor')); await tick();
  p.elements.load.events.click(); await tick();
  assert.equal(byId(p.card(2), 'response-2').value, 'Other card response draft');
  assert.equal(byId(p.card(2), 'comment-2').value, 'Other card comment draft', 'saving response does not clear comment draft');
  assert.equal(p.server.features[1].maintainerResponse, 'Other card response draft');
});

test('an uncertain comment stays locked across board reloads and restored thread reads', async () => {
  const p = await page(); await openComments(p.card(1));
  byId(p.card(1), 'comment-1').value = 'Uncertain comment draft';
  p.setSend(async () => { throw new Error('lost response'); });
  submit(byClass(p.card(1), 'comment-form')); await tick();
  const previousCard = p.card(1);
  p.elements.load.events.click(); await tick();
  assert.notEqual(p.card(1), previousCard);
  assert.equal(byId(p.card(1), 'comment-1').value, 'Uncertain comment draft');
  assert.equal(button(p.card(1), 'Post comment').disabled, true, 'restoring an open thread never unlocks an uncertain write');
  submit(byClass(p.card(1), 'comment-form')); await tick();
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
  button(p.card(1), 'Refresh comments').events.click(); await tick();
  assert.equal(button(p.card(1), 'Post comment').disabled, false);
});

test('board reload waits for an in-flight comment and preserves other drafts after the write settles', async () => {
  const p = await page(); await openComments(p.card(1));
  byId(p.card(1), 'comment-1').value = 'Posting once';
  byId(p.card(2), 'response-2').value = 'Keep other draft';
  let finish;
  p.setSend(() => new Promise((resolve) => { finish = () => resolve(response({ ok: true })); }));
  submit(byClass(p.card(1), 'comment-form'));
  const postingCard = p.card(1);
  const readsBefore = p.calls.filter((call) => call.url === '/api/board/admin' && !call.options?.method).length;
  p.elements.load.events.click(); await tick();
  assert.equal(p.card(1), postingCard, 'in-flight form is not replaced');
  assert.equal(button(p.card(1), 'Post comment').disabled, true);
  assert.equal(p.calls.filter((call) => call.url === '/api/board/admin' && !call.options?.method).length, readsBefore);
  finish(); await tick();
  assert.notEqual(p.card(1), postingCard, 'requested reload runs after the write settles');
  assert.equal(byId(p.card(1), 'comment-1').value, '', 'confirmed post clears only its own comment draft');
  assert.equal(byId(p.card(2), 'response-2').value, 'Keep other draft');
  assert.equal(button(p.card(1), 'Post comment').disabled, false);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
});

test('issue editor saves normalized links and removes them without resetting other drafts', async () => {
  const p = await page(); const card = p.card(1);
  const form = byClass(card, 'issue-editor');
  const input = byId(card, 'issue-1');
  assert.equal(form.children[0].attrs.for, 'issue-1');
  assert.equal(button(card, 'Remove issue').hidden, true);
  byId(p.card(2), 'response-2').value = 'Keep response draft';
  byId(card, 'comment-1').value = 'Keep comment draft';
  input.value = 'https://github.com/windoze95/cantinarr/issues/677#issuecomment-1';
  submit(form); submit(form); await tick();
  const writes = p.calls.filter((c) => c.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), { id: 1, action: 'link_issue', url: 'https://github.com/windoze95/cantinarr/issues/677#issuecomment-1' });
  assert.equal(input.value, 'https://github.com/windoze95/cantinarr/issues/677');
  assert.equal(byClass(card, 'issue-open').href, input.value);
  assert.equal(byClass(card, 'issue-open').target, '_blank');
  assert.equal(byClass(card, 'issue-open').rel, 'noopener noreferrer');
  assert.equal(button(card, 'Remove issue').hidden, false);
  assert.equal(byId(p.card(2), 'response-2').value, 'Keep response draft');
  assert.equal(byId(card, 'comment-1').value, 'Keep comment draft');
  button(card, 'Remove issue').events.click(); await tick();
  assert.equal(input.value, '');
  assert.equal(byClass(card, 'issue-open').hidden, true);
  assert.equal(p.server.features[0].githubIssueUrl, '');
});

test('issue drafts survive errors and status changes; full reload waits for an issue save', async () => {
  const p = await page();
  const draft = 'https://github.com/windoze95/cantinarr/issues/677';
  byId(p.card(1), 'issue-1').value = draft;
  button(p.card(2), 'Planned').events.click(); await tick();
  assert.equal(byId(p.card(1), 'issue-1').value, draft);
  p.setSend(async () => response({ error: 'invalid_issue_url' }, 400));
  submit(byClass(p.card(1), 'issue-editor')); await tick();
  assert.equal(byId(p.card(1), 'issue-1').value, draft);
  assert.match(byClass(byClass(p.card(1), 'issue-editor'), 'thread-status').textContent, /Enter a GitHub issue URL/);
  let finish;
  p.setSend(() => new Promise((resolve) => { finish = () => {
    p.server.features[0].githubIssueUrl = draft;
    resolve(response({ ok: true, githubIssueUrl: draft }));
  }; }));
  const card = p.card(1);
  submit(byClass(card, 'issue-editor'));
  p.elements.load.events.click(); await tick();
  assert.equal(p.card(1), card);
  assert.equal(button(card, 'Save issue').disabled, true);
  finish(); await tick();
  assert.notEqual(p.card(1), card);
  assert.equal(byId(p.card(1), 'issue-1').value, draft);
});

test('compact admin cards keep the response visible while management and long details expand independently', async () => {
  const p = await page();
  p.server.features[0].detail = 'Long description. '.repeat(60);
  p.server.features[0].contactEmail = 'private@example.test';
  p.elements.load.events.click(); await tick();
  const card = p.card(1);
  const manage = byClass(card, 'manage-panel');
  const responsePreview = byClass(card, 'maintainer-response');
  assert.equal(manage.open, false);
  assert.ok(!manage.contains(responsePreview), 'response remains visible outside the management disclosure');
  assert.ok(manage.contains(byClass(card, 'private-contact')));
  assert.equal(responsePreview.hidden, false);
  assert.equal(byId(card, 'response-preview-1').textContent, '<b>Pinned update</b>');
  assert.equal(byId(card, 'response-preview-1').children.length, 0);
  assert.match(byClass(card, 'board-metadata').textContent, /No issue.*Has response.*1 pending comment.*Contact provided/);
  assert.doesNotMatch(byClass(card, 'board-metadata').textContent, /private@example/);
  button(card, 'Show details').events.click();
  button(card, 'Read full response').events.click();
  manage.open = true;
  p.elements.load.events.click(); await tick();
  assert.equal(byClass(p.card(1), 'manage-panel').open, true);
  assert.match(byId(p.card(1), 'request-detail-1').className, /expanded/);
  assert.match(byId(p.card(1), 'response-preview-1').className, /expanded/);
});

test('filters and layout changes retain drafts, open panels, and an in-flight save on the same card', async () => {
  const p = await page();
  const card = p.card(1);
  const other = p.card(2);
  byClass(card, 'manage-panel').open = true;
  byId(card, 'response-1').value = 'Saving response';
  byId(other, 'issue-2').value = 'https://github.com/windoze95/cantinarr/issues/2';
  byId(other, 'comment-2').value = 'Keep this comment draft';
  let finish;
  p.setSend(() => new Promise((resolve) => { finish = () => resolve(response({ ok: true })); }));
  submit(byClass(card, 'response-editor'));
  const search = byId(p.elements['mod-controls'], 'board-search');
  search.value = 'Feature 2'; search.events.input();
  assert.equal(card.hidden, true);
  assert.equal(button(card, 'Save response').disabled, true);
  const list = walk(p.elements['mod-controls']).find((node) => node.dataset.view === 'list');
  list.events.click();
  search.value = ''; search.events.input();
  assert.equal(p.card(1), card, 'view changes must reuse a saving card');
  assert.equal(card.hidden, false);
  assert.equal(byClass(card, 'manage-panel').open, true);
  assert.equal(byId(other, 'comment-2').value, 'Keep this comment draft');
  assert.equal(byId(other, 'issue-2').value, 'https://github.com/windoze95/cantinarr/issues/2');
  finish(); await tick();
  assert.equal(p.card(1), card);
  assert.equal(button(card, 'Save response').disabled, false);
  assert.equal(byId(card, 'response-preview-1').textContent, 'Saving response');
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
});

test('confirmed metadata changes refresh active filters and auth clearing discards filtered private cards', async () => {
  const p = await page();
  p.server.features[0].contactDiscord = 'private-contact-name';
  p.elements.load.events.click(); await tick();
  const card = p.card(1);
  const issueFilter = byId(p.elements['mod-controls'], 'board-issue-filter');
  issueFilter.value = 'missing'; issueFilter.events.change();
  assert.equal(card.hidden, false);
  byId(card, 'issue-1').value = 'https://github.com/windoze95/cantinarr/issues/677';
  submit(byClass(card, 'issue-editor')); await tick();
  assert.equal(card.hidden, true, 'a saved issue leaves the missing-issue result set');
  assert.match(byClass(card, 'board-metadata').textContent, /Issue #677/);
  issueFilter.value = 'all'; issueFilter.events.change();
  assert.equal(p.card(1), card);
  assert.equal(card.hidden, false);
  const commentFilter = byId(p.elements['mod-controls'], 'board-comment-filter');
  commentFilter.value = 'pending'; commentFilter.events.change();
  const comments = await openComments(card);
  button(comments, 'Approve comment').events.click(); await tick();
  assert.equal(card.hidden, true, 'a moderated comment updates the pending-comment result set');
  assert.doesNotMatch(byClass(card, 'board-metadata').textContent, /pending comment/);
  p.elements.token.value = ''; p.elements.load.events.click();
  assert.equal(p.elements['mod-sections'].textContent, '');
  assert.equal(p.elements['mod-controls'].hidden, true);
  issueFilter.value = 'all'; issueFilter.events.change();
  assert.equal(p.elements['mod-sections'].textContent, '', 'old filter controls cannot restore discarded private cards');
});

test('pending card uses the configured Luna review state inside Manage request', async () => {
  const p = await page();
  p.server.reviewEnabled = true;
  p.server.features[0].status = 'pending';
  p.server.features[0].reviewState = 'waiting';
  p.elements.load.events.click(); await tick();
  assert.match(p.card(1).textContent, /Luna review will retry/);
  assert.doesNotMatch(p.card(1).textContent, /Luna review is not configured/);
});
