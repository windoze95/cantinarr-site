import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../public/roadmap/admin.html', import.meta.url), 'utf8')
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {};
    this.disabled = false; this.hidden = false; this.value = '';
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(event, handler) { this.events[event] = handler; }
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
  const elements = Object.fromEntries(['token', 'mod-status', 'mod-sections', 'load'].map((id) => [id, new Element('div')]));
  const calls = []; const server = { features: [feature(1), feature(2)], reviewEnabled: false };
  const comments = [comment(1, 'pending'), comment(2)];
  let send = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'respond') server.features.find((f) => f.id === body.id).maintainerResponse = body.body.trim();
    if (body.action === 'planned') server.features.find((f) => f.id === body.id).status = 'planned';
    if (body.action === 'comment') comments.push({ ...comment(3), author: 'maintainer', body: body.body });
    if (body.action === 'approve_comment') comments.find((c) => c.id === body.commentId).status = 'approved';
    if (body.action === 'delete_comment') comments.splice(comments.findIndex((c) => c.id === body.commentId), 1);
    return response({ ok: true });
  };
  let read = async (url) => url === '/api/board/admin' ? response(server) : response({ comments, nextCursor: null });
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), createTextNode: (text) => Object.assign(new Element('text'), { text }) },
    sessionStorage: { getItem: () => 'local-test-token', setItem() {} },
    setTimeout: () => 1,
    fetch: (url, options) => {
      calls.push({ url, options });
      return options?.method === 'POST' ? send(url, options) : read(url, options);
    },
  });
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
