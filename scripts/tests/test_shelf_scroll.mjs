import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Follow the deployed page's versioned asset instead of pinning an old script.
const homepage = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const scriptPaths = [...homepage.matchAll(/<script\b[^>]*\bsrc=["'](\/static\/reel-v\d+\.js)["'][^>]*>/g)]
  .map((match) => match[1]);
assert.equal(scriptPaths.length, 1, 'the homepage must load one media shelf script');
const scriptURL = new URL(`../../public${scriptPaths[0]}`, import.meta.url);
const source = readFileSync(scriptURL, 'utf8');

class Events {
  handlers = new Map();

  addEventListener(type, handler) {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  emit(type, event = {}) {
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}

class Classes {
  values = new Set();
  contains(name) { return this.values.has(name); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  toggle(name, force = !this.contains(name)) {
    if (force) this.add(name);
    else this.remove(name);
    return force;
  }
}

function page({ mobile = true, reducedMotion = false } = {}) {
  const window = new Events();
  Object.assign(window, { innerWidth: mobile ? 390 : 1440, innerHeight: 844, scrollY: 0 });
  const frames = [];
  window.requestAnimationFrame = (callback) => { frames.push(callback); };

  function mediaQuery(matches) {
    const query = new Events();
    query.matches = matches;
    query.change = (value) => {
      query.matches = value;
      query.emit('change', { matches: value });
    };
    return query;
  }
  const mobileQuery = mediaQuery(mobile);
  const motionQuery = mediaQuery(reducedMotion);
  window.matchMedia = (query) => query.includes('prefers-reduced-motion') ? motionQuery : mobileQuery;

  const shelfWindow = new Events();
  Object.assign(shelfWindow, {
    classList: new Classes(), scrollLeft: 0, clientWidth: 390, scrollWidth: 840,
    getBoundingClientRect: () => ({ top: 820 - window.scrollY, height: 280, bottom: 1100 - window.scrollY }),
  });
  const shelf = { style: { setProperty() {} } };
  const nav = { getBoundingClientRect: () => ({ bottom: 66 }) };
  const elements = { '.shelf': shelf, '.shelf-window': shelfWindow, '.site-nav': nav };
  const document = {
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  vm.runInNewContext(source, {
    document, window, navigator: {},
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
  }, { filename: fileURLToPath(scriptURL) });

  function flush() {
    assert.ok(frames.length <= 1, 'scroll and resize must share one scheduled frame');
    while (frames.length) frames.shift()();
  }
  function scroll(y) {
    window.scrollY = y;
    window.emit('scroll');
    flush();
  }
  function touch(type, x, y) {
    shelfWindow.emit(type, { touches: x === undefined ? [] : [{ clientX: x, clientY: y }] });
  }
  return { window, shelfWindow, mobileQuery, motionQuery, flush, scroll, touch };
}

test('native page scrolling reveals the last jackets before the shelf reaches the nav, and reverses', () => {
  const p = page();
  assert.ok(p.shelfWindow.classList.contains('scroll-linked'));
  assert.equal(p.shelfWindow.scrollLeft, 0);
  p.scroll(500);
  const middle = p.shelfWindow.scrollLeft;
  assert.ok(middle > 100 && middle < 350, 'a partly traversed shelf must show intermediate jackets');
  p.scroll(730); // Shelf top is still 90px down: 24px below the navigation.
  assert.equal(p.shelfWindow.scrollLeft, 450, 'book and music must be reached while the shelf is visible');
  p.scroll(1000);
  assert.equal(p.shelfWindow.scrollLeft, 450, 'movement must stop at the overflow boundary');
  p.scroll(500);
  assert.equal(p.shelfWindow.scrollLeft, middle);
  p.scroll(0);
  assert.equal(p.shelfWindow.scrollLeft, 0);
});

test('desktop and reduced-motion visitors retain manual horizontal scrolling', () => {
  for (const options of [{ mobile: false }, { reducedMotion: true }]) {
    const p = page(options);
    p.shelfWindow.scrollLeft = 137;
    p.scroll(730);
    assert.equal(p.shelfWindow.scrollLeft, 137);
    assert.ok(!p.shelfWindow.classList.contains('scroll-linked'));
  }
});

test('changing motion preferences or crossing the mobile breakpoint updates automatic movement', () => {
  const p = page();
  p.scroll(500);
  const middle = p.shelfWindow.scrollLeft;
  p.motionQuery.change(true);
  p.flush();
  p.scroll(730);
  assert.equal(p.shelfWindow.scrollLeft, middle);
  assert.ok(!p.shelfWindow.classList.contains('scroll-linked'));
  p.motionQuery.change(false);
  p.flush();
  assert.equal(p.shelfWindow.scrollLeft, 450);
  p.mobileQuery.change(false);
  p.window.innerWidth = 1440;
  p.window.emit('resize');
  p.flush();
  p.shelfWindow.scrollLeft = 81;
  p.scroll(500);
  assert.equal(p.shelfWindow.scrollLeft, 81);
  assert.ok(!p.shelfWindow.classList.contains('scroll-linked'));
});

test('vertical gestures and finished or cancelled touches do not take over the shelf', () => {
  const p = page();
  p.touch('touchstart', 200, 200);
  p.touch('touchmove', 202, 130);
  p.touch('touchend');
  p.touch('touchmove', 140, 200);
  p.touch('touchstart', 200, 200);
  p.touch('touchcancel');
  p.touch('touchmove', 140, 200);
  p.shelfWindow.emit('wheel', { deltaX: 0, deltaY: 40, shiftKey: false });
  p.scroll(730);
  assert.equal(p.shelfWindow.scrollLeft, 450);
  assert.ok(p.shelfWindow.classList.contains('scroll-linked'));
});

test('a horizontal swipe keeps its manual position during later page scrolling', () => {
  const p = page();
  p.scroll(500);
  p.touch('touchstart', 200, 200);
  p.touch('touchmove', 170, 202);
  p.touch('touchend');
  p.shelfWindow.scrollLeft = 123;
  p.scroll(730);
  p.scroll(0);
  assert.equal(p.shelfWindow.scrollLeft, 123);
  assert.ok(!p.shelfWindow.classList.contains('scroll-linked'));
});

test('horizontal wheel, Shift-wheel, and keyboard focus keep manual control', () => {
  for (const [type, event] of [
    ['wheel', { deltaX: 30, deltaY: 2, shiftKey: false }],
    ['wheel', { deltaX: 0, deltaY: 30, shiftKey: true }],
    ['focusin', {}],
  ]) {
    const p = page();
    p.scroll(500);
    p.shelfWindow.emit(type, event);
    p.shelfWindow.scrollLeft = 167;
    p.scroll(730);
    p.window.emit('resize');
    p.flush();
    assert.equal(p.shelfWindow.scrollLeft, 167, `${type} must win over later page scroll and resize`);
    assert.ok(!p.shelfWindow.classList.contains('scroll-linked'));
  }
});
