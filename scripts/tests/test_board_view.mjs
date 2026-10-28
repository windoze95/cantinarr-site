import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../public/static/board-view-v1.js', import.meta.url), 'utf8');
class Element {
  constructor(tag, document) {
    this.tag = tag; this.document = document; this.children = []; this.attrs = {}; this.events = {};
    this.dataset = {}; this.hidden = false; this.value = ''; this.parentNode = null;
  }
  set textContent(value) { this.text = String(value); this.children.forEach((child) => { child.parentNode = null; }); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child === before) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0, 'insertBefore reference must be a child');
    this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(name, handler) { this.events[name] = handler; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.document.activeElement = this; }
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
const isVisible = (node) => !node.hidden && (!node.parentNode || isVisible(node.parentNode));
const feature = (id, values = {}) => ({
  id, title: 'Idea ' + id, detail: '', status: 'open', createdAt: '2026-10-28T12:00:00Z',
  upvotes: 1, downvotes: 0, commentCount: 0, pendingCommentCount: 0,
  maintainerResponse: '', githubIssueUrl: '', contactEmail: '', contactDiscord: '', ...values,
});

function page({ admin = false, mobile = false, defaultView } = {}) {
  const document = { activeElement: null };
  document.createElement = (tag) => new Element(tag, document);
  const root = document.createElement('div'); const controls = document.createElement('div');
  const window = { matchMedia: () => ({ matches: mobile }) };
  vm.runInNewContext(source, { window, document });
  const rendered = []; let changes = 0;
  const statuses = (admin ? ['pending', 'open', 'planned', 'shipped', 'declined'] : ['open', 'planned', 'shipped'])
    .map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
  const controller = window.RoadmapBoard.create({ root, controls, statuses, admin, defaultView,
    onChange: () => { changes++; },
    renderItem(item) {
      rendered.push(item.id);
      const card = document.createElement('li'); card.dataset.feature = item.id;
      const title = document.createElement('h3'); title.textContent = item.title; card.appendChild(title);
      const input = document.createElement('textarea'); card.appendChild(input);
      const details = document.createElement('details'); card.appendChild(details);
      return card;
    },
  });
  const all = () => [...walk(controls), ...walk(root)];
  const byId = (id) => all().find((node) => node.id === id);
  const byClass = (name) => all().filter((node) => node.className?.split(' ').includes(name));
  const button = (key, value) => all().find((node) => node.tag === 'button' && node.dataset[key] === value);
  const card = (id) => walk(root).find((node) => node.dataset.feature === id);
  const visibleCards = () => walk(root).filter((node) => node.dataset.feature !== undefined && isVisible(node));
  const set = (id, value) => { const node = byId(id); node.value = value; node.events[id === 'board-search' ? 'input' : 'change'](); };
  return { root, controls, controller, document, rendered, byId, byClass, button, card, set,
    visibleCards, ids: () => visibleCards().map((node) => node.dataset.feature), changes: () => changes };
}

test('desktop lanes bound initial results, show totals, and focus the first revealed idea', () => {
  const p = page();
  assert.equal(p.controls.hidden, true);
  const items = Array.from({ length: 45 }, (_, index) => feature(index + 1, { status: ['open', 'planned', 'shipped'][index % 3] }));
  p.controller.setItems(items);
  assert.equal(p.controls.hidden, false);
  assert.equal(p.root.dataset.view, 'board');
  assert.equal(p.visibleCards().length, 18);
  assert.equal(p.rendered.length, 45);
  assert.equal(p.button('status', 'all').textContent, 'All (45)');
  assert.equal(p.button('status', 'shipped').textContent, 'Shipped (15)');
  assert.match(p.byClass('board-results')[0].textContent, /18 of 45 matching ideas. 45 total/);
  const more = p.byClass('board-lane')[0].children.find((node) => node.className === 'board-more');
  assert.match(more.attrs['aria-label'], /open ideas, 9 remaining/);
  more.events.click();
  assert.equal(p.visibleCards().length, 24);
  assert.equal(p.document.activeElement, p.card(19));
  assert.equal(p.rendered.length, 45, 'paging must not recreate cards');
});

test('mobile uses a bounded list, paging appends, and changing filters resets its limit', () => {
  const p = page({ mobile: true });
  p.controller.setItems(Array.from({ length: 45 }, (_, index) => feature(index + 1)));
  assert.equal(p.root.dataset.view, 'list');
  assert.equal(p.visibleCards().length, 20);
  const more = p.byClass('board-list-view')[0].children.find((node) => node.className === 'board-more');
  more.events.click();
  assert.equal(p.visibleCards().length, 40);
  assert.equal(p.document.activeElement, p.card(21));
  more.events.click();
  assert.equal(p.visibleCards().length, 45);
  assert.equal(more.hidden, true);
  p.set('board-search', 'Idea');
  assert.equal(p.visibleCards().length, 20);
  assert.equal(more.hidden, false);
});

test('search finds shipped titles, details, responses, IDs, and issue numbers across all statuses', () => {
  const p = page();
  p.controller.setItems([
    feature(1, { title: 'Plex libraries' }),
    feature(2, { status: 'shipped', title: 'Household access', detail: 'Use an external catalog', maintainerResponse: 'Available in release 42', githubIssueUrl: 'https://github.com/windoze95/cantinarr/issues/741' }),
  ]);
  for (const query of ['household', 'EXTERNAL catalog', 'release 42', '#2', '741', '#741', 'household 741']) {
    p.set('board-search', query);
    assert.deepEqual(p.ids(), [2], query);
  }
  assert.equal(p.button('status', 'open').textContent, 'Open (1)', 'status totals do not disappear during a search');
  p.button('status', 'open').events.click();
  assert.deepEqual(p.ids(), []);
  assert.match(p.byClass('board-empty').find(isVisible).textContent, /Clear filters/);
  p.byClass('board-reset')[0].events.click();
  assert.deepEqual(p.ids(), [1, 2]);
  assert.equal(p.byClass('board-reset')[0].hidden, true);
});

test('combined metadata filters include private-contact presence but never search contact values', () => {
  const p = page({ admin: true, defaultView: 'list' });
  p.controller.setItems([
    feature(1, { status: 'pending', maintainerResponse: 'Needs more detail', pendingCommentCount: 1, contactEmail: 'private-only@example.test' }),
    feature(2, { maintainerResponse: 'Planned soon', pendingCommentCount: 2, githubIssueUrl: 'https://github.com/a/b/issues/4' }),
    feature(3, { contactDiscord: 'private-discord', commentCount: 1 }),
  ]);
  p.set('board-issue-filter', 'missing');
  p.set('board-response-filter', 'present');
  p.set('board-comment-filter', 'pending');
  p.set('board-contact-filter', 'present');
  assert.deepEqual(p.ids(), [1]);
  assert.equal(p.byClass('board-filters')[0].children[0].textContent, 'Filters (4)');
  p.byClass('board-reset')[0].events.click();
  for (const query of ['private-only@example.test', 'private-discord']) {
    p.set('board-search', query);
    assert.deepEqual(p.ids(), [], 'private contacts are not searchable');
  }
  assert.doesNotMatch(p.controls.textContent, /private-only|private-discord/);
});

test('public comments filter counts published comments and exposes no admin-only controls', () => {
  const p = page();
  p.controller.setItems([feature(1, { pendingCommentCount: 2 }), feature(2, { commentCount: 1 })]);
  p.set('board-comment-filter', 'present'); assert.deepEqual(p.ids(), [2]);
  p.set('board-comment-filter', 'missing'); assert.deepEqual(p.ids(), [1]);
  assert.equal(p.byId('board-contact-filter'), undefined);
  assert.ok(p.byId('board-comment-filter').children.every((option) => option.value !== 'pending'));
});

test('votes sort independently by upvotes then downvotes, creation date, and stable ID', () => {
  const p = page({ defaultView: 'list' });
  p.controller.setItems([
    feature(4, { upvotes: 5, downvotes: 2 }),
    feature(3, { upvotes: 5, downvotes: 0 }),
    feature(2, { upvotes: 5, downvotes: 0 }),
    feature(5, { upvotes: 6, downvotes: 100 }),
    feature(1, { upvotes: 5, downvotes: 0, createdAt: '2026-10-27T12:00:00Z' }),
  ]);
  assert.deepEqual(p.ids(), [5, 1, 2, 3, 4], 'upvotes are not replaced with a net score');
  p.set('board-sort', 'oldest'); assert.deepEqual(p.ids(), [1, 2, 3, 4, 5]);
  p.set('board-sort', 'newest'); assert.deepEqual(p.ids(), [5, 4, 3, 2, 1]);
  p.set('board-sort', 'title'); assert.deepEqual(p.ids(), [1, 2, 3, 4, 5]);
});

test('admin default list prioritizes pending review and explicit date sort is global', () => {
  const p = page({ admin: true, defaultView: 'list' });
  p.controller.setItems([
    feature(1, { upvotes: 100 }),
    feature(2, { status: 'pending', upvotes: 0, createdAt: '2026-10-26T12:00:00Z' }),
    feature(3, { status: 'planned', upvotes: 20 }),
  ]);
  assert.deepEqual(p.ids(), [2, 1, 3]);
  p.set('board-sort', 'newest'); assert.deepEqual(p.ids(), [3, 1, 2]);
});

test('filtering, pagination, and layout changes keep card drafts, disclosure state, and pending controls', () => {
  const p = page();
  p.controller.setItems(Array.from({ length: 12 }, (_, index) => feature(index + 1)));
  const card = p.card(1); const input = card.children[1]; const details = card.children[2];
  input.value = 'Unsaved response'; input.disabled = true; details.open = true;
  p.set('board-search', 'Idea 12');
  assert.equal(card.hidden, true);
  p.button('view', 'list').events.click();
  p.set('board-search', '');
  p.button('view', 'board').events.click();
  assert.equal(p.card(1), card);
  assert.equal(input.value, 'Unsaved response');
  assert.equal(input.disabled, true, 'an in-flight editor remains disabled');
  assert.equal(details.open, true);
  assert.equal(p.rendered.length, 12);
  assert.equal(p.changes(), 5);
});

test('refresh uses changed metadata for filters, counts, status lanes, and sorting without rerendering cards', () => {
  const p = page(); const one = feature(1); const two = feature(2);
  p.controller.setItems([one, two]);
  const original = p.card(1);
  p.set('board-issue-filter', 'linked'); assert.deepEqual(p.ids(), []);
  one.githubIssueUrl = 'https://github.com/a/b/issues/8'; one.status = 'planned';
  p.controller.refresh();
  assert.deepEqual(p.ids(), [1]);
  assert.equal(p.card(1), original);
  assert.equal(p.button('status', 'planned').textContent, 'Planned (1)');
  assert.equal(original.parentNode.parentNode.dataset.status, 'planned');
  p.set('board-response-filter', 'present'); assert.deepEqual(p.ids(), []);
  one.maintainerResponse = 'Shipped in v1'; p.controller.refresh(); assert.deepEqual(p.ids(), [1]);
  p.byClass('board-reset')[0].events.click(); p.button('view', 'list').events.click();
  two.upvotes = 9; p.controller.refresh(); assert.deepEqual(p.ids(), [2, 1]);
  assert.equal(p.rendered.length, 2);
});

test('clearing authentication removes all cards, hides controls, and resets filters before a later load', () => {
  const p = page({ admin: true });
  p.controller.setItems([feature(1, { title: 'Private pending idea', status: 'pending' })]);
  p.set('board-search', 'Private');
  p.controller.clear();
  assert.equal(p.controls.hidden, true);
  assert.equal(p.root.textContent, '');
  assert.equal(p.root.children.length, 0);
  p.controller.refresh();
  assert.equal(p.root.children.length, 0, 'refresh cannot restore cleared private state');
  p.controller.setItems([feature(2)]);
  assert.equal(p.controls.hidden, false);
  assert.equal(p.byId('board-search').value, '');
  assert.deepEqual(p.ids(), [2]);
  assert.doesNotMatch(p.root.textContent, /Private pending idea/);
});

test('saving metadata that removes the focused card from a filter moves focus back to search', () => {
  const p = page(); const item = feature(1);
  p.controller.setItems([item]);
  p.set('board-issue-filter', 'missing');
  p.card(1).children[1].focus();
  item.githubIssueUrl = 'https://github.com/a/b/issues/8';
  p.controller.refresh();
  assert.equal(p.card(1).hidden, true);
  assert.equal(p.document.activeElement, p.byId('board-search'));
});

test('empty boards distinguish no data from no filter matches and still expose search controls', () => {
  const p = page();
  p.controller.setItems([]);
  assert.equal(p.controls.hidden, false);
  assert.match(p.byClass('board-empty').find(isVisible).textContent, /No ideas on the board yet/);
  assert.match(p.byClass('board-results')[0].textContent, /0 of 0 matching ideas. 0 total/);
});
