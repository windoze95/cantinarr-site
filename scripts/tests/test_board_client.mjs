import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../public/roadmap/index.html', import.meta.url), 'utf8')
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.disabled = false; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(event, handler) { this.events[event] = handler; }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const feature = () => ({ id: 1, title: '<img onerror=alert(1)>', detail: 'Plain text', status: 'open', upvotes: 7, downvotes: 3, vote: null });
async function page() {
  const elements = Object.fromEntries(['board-status', 'board-list', 'shipped-title', 'shipped-count', 'shipped-list', 'suggest-form', 'form-status']
    .map((id) => [id, new Element('div')]));
  const events = {}; const calls = [];
  const server = { features: [feature()], siteKey: null };
  let send = async (_, options) => {
    const desired = JSON.parse(options.body).vote;
    const item = server.features[0];
    if (item.vote === 'up') item.upvotes--;
    if (item.vote === 'down') item.downvotes--;
    if (desired === 'up') item.upvotes++;
    if (desired === 'down') item.downvotes++;
    item.vote = desired;
    return new Response(JSON.stringify({ ok: true, ...item }));
  };
  let read = async () => new Response(JSON.stringify(server));
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag) },
    window: { addEventListener: (event, handler) => { events[event] = handler; } },
    fetch: (url, options) => {
      calls.push({ url, options });
      return options?.method === 'POST' ? send(url, options) : read();
    },
  });
  await tick();
  const controls = () => elements['board-list'].children[0].children[0];
  const buttons = () => controls().children;
  const count = (direction) => buttons()[direction].children[1].textContent;
  return { elements, events, calls, server, controls, buttons, count,
    setSend: (handler) => { send = handler; }, setRead: (handler) => { read = handler; } };
}

test('client serializes repeated taps, sends desired states, switches and removes using server counts', async () => {
  const p = await page();
  const [up, down] = p.buttons();
  assert.equal(p.count(0), '7'); assert.equal(p.count(1), '3');
  assert.match(up.attrs['aria-label'], /7 upvotes/);
  assert.equal(up.attrs['aria-pressed'], 'false');
  let finish;
  p.setSend((_, options) => new Promise((resolve) => {
    assert.deepEqual(JSON.parse(options.body), { id: 1, vote: 'up' });
    finish = () => resolve(new Response(JSON.stringify({ upvotes: 8, downvotes: 3, vote: 'up' })));
  }));
  up.events.click(); up.events.click(); down.events.click();
  assert.equal(p.calls.filter((c) => c.options?.method === 'POST').length, 1);
  assert.ok(up.disabled && down.disabled);
  assert.equal(p.count(0), '7', 'no optimistic counter');
  finish(); await tick();
  assert.equal(p.count(0), '8'); assert.equal(p.count(1), '3');
  assert.equal(up.attrs['aria-pressed'], 'true'); assert.match(up.attrs['aria-label'], /^Remove upvote/);
  assert.ok(!up.disabled && !down.disabled);
  p.setSend(async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), { id: 1, vote: 'down' });
    return new Response(JSON.stringify({ upvotes: 7, downvotes: 4, vote: 'down' }));
  });
  down.events.click(); await tick();
  assert.equal(up.attrs['aria-pressed'], 'false'); assert.equal(down.attrs['aria-pressed'], 'true');
  assert.equal(p.count(0), '7'); assert.equal(p.count(1), '4');
  p.setSend(async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), { id: 1, vote: null });
    return new Response(JSON.stringify({ upvotes: 7, downvotes: 3, vote: null }));
  });
  down.events.click(); await tick();
  assert.equal(down.attrs['aria-pressed'], 'false');
  assert.match(down.attrs['aria-label'], /3 downvotes/);
  assert.equal(p.elements['board-list'].children[0].children[1].children[0].children[0].textContent, '<img onerror=alert(1)>');
});

test('lost reply reconciles a committed vote and the next active tap removes it', async () => {
  const p = await page(); const [up, down] = p.buttons();
  p.setSend(async () => {
    Object.assign(p.server.features[0], { upvotes: 7, downvotes: 4, vote: 'down' });
    throw new Error('lost response');
  });
  down.events.click(); await tick();
  assert.equal(p.count(1), '4'); assert.equal(down.attrs['aria-pressed'], 'true');
  assert.ok(!up.disabled && !down.disabled);
  assert.match(p.elements['board-status'].textContent, /counts have been refreshed/);
  p.setSend(async (_, options) => {
    assert.equal(JSON.parse(options.body).vote, null);
    return new Response(JSON.stringify({ upvotes: 7, downvotes: 3, vote: null }));
  });
  down.events.click(); await tick(); assert.equal(p.count(1), '3');
});

test('rate limit and malformed success reconcile; unavailable refresh keeps item locked', async () => {
  const p = await page(); const [up, down] = p.buttons();
  p.setSend(async () => new Response('{"error":"rate_limited"}', { status: 429 }));
  up.events.click(); await tick();
  assert.match(p.elements['board-status'].textContent, /lot of votes/);
  assert.equal(p.count(0), '7'); assert.ok(!up.disabled && !down.disabled);
  p.setSend(async () => new Response('{}'));
  up.events.click(); await tick(); assert.equal(p.count(0), '7');
  p.setSend(async () => { throw new Error('offline'); });
  p.setRead(async () => { throw new Error('offline'); });
  down.events.click(); await tick();
  assert.ok(up.disabled && down.disabled);
  assert.match(p.elements['board-status'].textContent, /Reload the board/);
});

test('back/forward restoration refreshes cookie-backed state and shipped totals remain read-only', async () => {
  const p = await page();
  Object.assign(p.server.features[0], { vote: 'down', upvotes: 12, downvotes: 6 });
  p.events.pageshow({ persisted: true }); await tick();
  assert.equal(p.count(0), '12'); assert.equal(p.count(1), '6');
  assert.equal(p.buttons()[1].attrs['aria-pressed'], 'true');
  p.server.features[0].status = 'shipped';
  p.events.pageshow({ persisted: true }); await tick();
  const controls = p.elements['shipped-list'].children[0].children[0];
  assert.ok(controls.children.every((btn) => btn.disabled && !btn.events.click));
  assert.equal(controls.children[0].children[1].textContent, '12');
  assert.equal(controls.children[1].children[1].textContent, '6');
});

test('history restoration waits for an outstanding vote before replacing controls', async () => {
  const p = await page(); const [up, down] = p.buttons();
  let finish;
  p.setSend(() => new Promise((resolve) => {
    finish = () => {
      Object.assign(p.server.features[0], { vote: 'down', upvotes: 7, downvotes: 4 });
      resolve(new Response(JSON.stringify({ upvotes: 7, downvotes: 4, vote: 'down' })));
    };
  }));
  down.events.click();
  const reads = p.calls.filter((call) => !call.options?.method).length;
  p.events.pageshow({ persisted: true }); await tick();
  assert.equal(p.calls.filter((call) => !call.options?.method).length, reads);
  assert.ok(up.disabled && down.disabled);
  finish(); await tick();
  assert.equal(p.calls.filter((call) => !call.options?.method).length, reads + 1);
  assert.equal(p.buttons()[1].attrs['aria-pressed'], 'true');
  assert.equal(p.count(1), '4'); assert.ok(!p.buttons()[1].disabled);
});
