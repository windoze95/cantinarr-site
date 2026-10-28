import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const viewSource = readFileSync(new URL('../../public/static/board-view-v1.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../public/roadmap/index.html', import.meta.url), 'utf8')
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.value = ''; this.open = false; }
  set textContent(value) { this.text = value; this.children.forEach((child) => { child.parentNode = null; }); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  focus() {}
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(event, handler) { this.events[event] = handler; }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const hasClass = (el, name) => (el.className || '').split(' ').includes(name);
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) { const found = find(child, predicate); if (found) return found; }
}
const child = (root, className) => find(root, (el) => hasClass(el, className));
const feature = (id = 1, status = 'open') => ({ id, title: 'One request', detail: 'Plain text', status,
  upvotes: 1, downvotes: 0, vote: null, commentCount: 1, maintainerResponse: '<script>never execute</script>' });
async function page({ siteKey = null, features = [feature()] } = {}) {
  const elements = Object.fromEntries(['board-status', 'board-list', 'board-controls', 'suggest-form', 'form-status']
    .map((id) => [id, new Element('div')]));
  const calls = []; const events = {}; const widgets = []; const resets = []; const removed = [];
  const server = { siteKey, features };
  let readComments = async () => new Response(JSON.stringify({ comments: [
    { id: 1, body: '<img src=x onerror=bad()>', author: 'maintainer', createdAt: '2026-10-27T12:00:00Z' }
  ], nextCursor: null }));
  let send = async () => new Response('{"ok":true,"queued":true}');
  const window = { addEventListener: (event, handler) => { events[event] = handler; }, turnstile: {
    render: (slot, options) => { const id = widgets.length; widgets.push({ slot, options }); return id; },
    getResponse: (id) => 'challenge-' + id, reset: (id) => resets.push(id), remove: (id) => removed.push(id)
  } };
  vm.runInNewContext(viewSource + '\n' + source, {
    document: { querySelector: () => new Element('a'), getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), head: new Element('head') },
    window,
    fetch: (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') return send(url, options);
      if (url.startsWith('/api/board/comments?')) return readComments(url);
      return Promise.resolve(new Response(JSON.stringify(server)));
    },
  });
  await tick();
  function item(id = 1) {
    return find(elements['board-list'], (el) => el.id === 'feature-' + id);
  }
  function controls(id = 1) {
    const root = item(id); const discussion = child(root, 'item-comments'); const form = child(root, 'comment-form');
    return { root, discussion, form, input: find(form, (el) => el.tag === 'textarea'),
      submit: child(form, 'comment-submit'), status: child(form, 'comment-status'),
      list: child(root, 'comment-list'), more: child(root, 'comment-more') };
  }
  async function open(id = 1) { const c = controls(id); c.discussion.open = true; c.discussion.events.toggle(); await tick(); return c; }
  return { elements, events, calls, window, widgets, resets, removed, server, controls, open,
    setReadComments: (fn) => { readComments = fn; }, setSend: (fn) => { send = fn; } };
}

const write = (control, text) => { control.input.value = text; control.input.events.input(); };
const submit = (control) => control.form.events.submit({ preventDefault() {} });

test('only linked items show an accessible GitHub icon, including shipped items', async () => {
  const url = 'https://github.com/windoze95/cantinarr/issues/677';
  const p = await page({ features: [feature(1), { ...feature(2, 'shipped'), githubIssueUrl: url },
    { ...feature(3), githubIssueUrl: 'javascript:alert(1)' },
    { ...feature(4), githubIssueUrl: 'https://github.com.evil.test/a/b/issues/1' }] });
  assert.equal(child(p.controls(1).root, 'issue-link'), undefined);
  assert.equal(child(p.controls(3).root, 'issue-link'), undefined);
  assert.equal(child(p.controls(4).root, 'issue-link'), undefined);
  const link = child(p.controls(2).root, 'issue-link');
  assert.equal(link.href, url);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.attrs['aria-label'], /windoze95\/cantinarr#677.*new tab/);
  assert.equal(link.title, link.attrs['aria-label']);
  assert.equal(link.children[0].src, '/static/github-issue-v1.svg');
  assert.equal(link.children[0].alt, '');
  assert.equal(child(p.controls(2).discussion, 'issue-link'), undefined, 'icon stays outside comments');
});

test('pinned response stays outside collapsed discussion and public comments load only when opened', async () => {
  const p = await page(); const c = p.controls();
  assert.equal(p.calls.length, 1);
  assert.equal(c.discussion.open, false);
  const response = child(c.root, 'maintainer-response');
  assert.match(response.textContent, /Maintainer response<script>never execute<\/script>/);
  assert.equal(find(c.discussion, (el) => hasClass(el, 'maintainer-response')), undefined);
  assert.equal(find(response, (el) => el.tag === 'script'), undefined);
  await p.open();
  assert.equal(p.calls.length, 2);
  assert.equal(c.list.children.length, 1);
  assert.match(c.list.textContent, /Maintainer/);
  assert.match(c.list.textContent, /<img src=x onerror=bad\(\)>/);
  assert.equal(find(c.list, (el) => el.tag === 'img'), undefined);
  assert.equal(find(c.list, (el) => el.tag === 'time').attrs.datetime, '2026-10-27T12:00:00Z');
  c.discussion.open = false; c.discussion.events.toggle(); await p.open();
  assert.equal(p.calls.length, 2, 'reopening retains loaded discussion');
});

test('comments page in ascending API order and failed page can be retried without duplicate rows', async () => {
  const p = await page(); let pageNumber = 0;
  p.setReadComments(async (url) => {
    pageNumber++;
    if (pageNumber === 1) return new Response(JSON.stringify({ comments: [{ id: 1, body: 'First', author: 'visitor', createdAt: '' }], nextCursor: 1 }));
    assert.equal(url, '/api/board/comments?id=1&after=1');
    if (pageNumber === 2) throw new Error('offline');
    return new Response(JSON.stringify({ comments: [{ id: 2, body: 'Second', author: 'visitor', createdAt: '' }], nextCursor: null }));
  });
  const c = await p.open(); assert.equal(c.more.hidden, false);
  c.more.events.click(); await tick();
  assert.equal(c.list.children.length, 1); assert.equal(c.more.hidden, false);
  c.more.events.click(); await tick();
  assert.equal(c.list.children.length, 2); assert.match(c.list.textContent, /First.*Second/); assert.equal(c.more.hidden, true);
});

test('anonymous submission is serialized, waits for approval, and does not inflate approved count', async () => {
  const p = await page(); const c = await p.open(); write(c, 'Useful context');
  let finish;
  p.setSend((url, options) => new Promise((resolve) => {
    assert.equal(url, '/api/board/comments');
    assert.deepEqual(JSON.parse(options.body), { id: 1, body: 'Useful context', website: '' });
    finish = () => resolve(new Response('{"ok":true,"queued":true}'));
  }));
  submit(c); submit(c);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
  assert.equal(c.submit.disabled, true); assert.equal(c.input.disabled, true);
  finish(); await tick();
  assert.equal(c.input.value, ''); assert.match(c.status.textContent, /waiting for maintainer approval/);
  assert.equal(c.list.children.length, 1); assert.equal(c.submit.disabled, false);
  assert.equal(c.discussion.children[0].textContent, '1 comment');
});

test('failed or uncertain submission keeps draft and never automatically resends', async () => {
  const p = await page(); const c = await p.open(); write(c, 'Do not lose this');
  p.setSend(async () => { throw new Error('lost response'); }); submit(c); await tick();
  assert.equal(c.input.value, 'Do not lose this'); assert.match(c.status.textContent, /Couldn’t confirm/);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
  p.setSend(async () => new Response('{"error":"rate_limited"}', { status: 429 })); submit(c); await tick();
  assert.equal(c.input.value, 'Do not lose this'); assert.match(c.status.textContent, /Try again tomorrow/);
  p.events.pageshow({ persisted: true }); await tick();
  assert.equal(p.controls().input.value, 'Do not lose this'); assert.equal(p.controls().discussion.open, true);
});

test('each discussion uses its own Turnstile token and blocks posting while challenge is unavailable', async () => {
  const p = await page({ siteKey: 'public-key', features: [feature(), feature(2)] });
  const c = await p.open(); write(c, 'Needs a challenge'); submit(c);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 0);
  p.window.cantinarrTurnstileLoaded();
  assert.equal(p.widgets.length, 2, 'idea widget and first discussion widget');
  const second = await p.open(2); assert.equal(p.widgets.length, 3);
  write(second, 'Second request'); submit(second); await tick();
  const payload = JSON.parse(p.calls.find((call) => call.options?.method === 'POST').options.body);
  assert.equal(payload.id, 2); assert.equal(payload.turnstile, 'challenge-2');
  assert.deepEqual(p.resets, [2]);
});

test('shipped requests allow comments while votes stay read-only; history refresh waits for comment writes', async () => {
  const p = await page({ features: [feature(1, 'shipped')] }); const c = await p.open();
  assert.equal(child(c.root, 'vote-controls').children.every((button) => button.disabled), true);
  write(c, 'Thanks for shipping');
  let finish;
  p.setSend(() => new Promise((resolve) => { finish = () => resolve(new Response('{"ok":true,"queued":true}')); }));
  submit(c); const reads = p.calls.filter((call) => call.url === '/api/board').length;
  p.events.pageshow({ persisted: true }); await tick();
  assert.equal(p.calls.filter((call) => call.url === '/api/board').length, reads);
  finish(); await tick();
  assert.equal(p.calls.filter((call) => call.url === '/api/board').length, reads + 1);
});

test('search and display changes preserve an open discussion and in-flight comment', async () => {
  const p = await page(); const c = await p.open(); write(c, 'Keep my draft');
  let finish;
  p.setSend(() => new Promise((resolve) => { finish = () => resolve(new Response('{"ok":true,"queued":true}')); }));
  submit(c);
  const search = find(p.elements['board-controls'], (el) => el.id === 'board-search');
  search.value = 'no match'; search.events.input();
  assert.equal(c.root.hidden, true);
  search.value = ''; search.events.input();
  const listButton = find(p.elements['board-controls'], (el) => el.dataset.view === 'list');
  listButton.events.click();
  assert.equal(p.controls().root, c.root);
  assert.equal(c.input.value, 'Keep my draft');
  assert.equal(c.discussion.open, true);
  assert.equal(c.submit.disabled, true);
  submit(c);
  assert.equal(p.calls.filter((call) => call.options?.method === 'POST').length, 1);
  finish(); await tick();
  assert.equal(c.input.value, '');
  assert.equal(c.submit.disabled, false);
});
