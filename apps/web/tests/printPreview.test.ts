import test from 'node:test';
import assert from 'node:assert/strict';
import { printResumePreview } from '../src/printPreview';

// DOM behavior and successful printing are covered in the Chrome regression.
// These guards must reject before touching fonts or the native print dialog.
for (const [name, root, expected] of [
  ['detached editor', { isConnected: false }, /已关闭/],
  ['empty preview', { isConnected: true, querySelector: () => null }, /尚未就绪/],
  ['overflow preview', { isConnected: true, querySelector: () => ({ dataset: { overflow: 'true' } }) }, /内容超过单页高度/],
] as const) {
  test(`printing rejects ${name} without opening the native dialog`, async () => {
    let calls = 0;
    await assert.rejects(printResumePreview(root as unknown as HTMLElement, { print: () => { calls++; } } as unknown as Window), expected);
    assert.equal(calls, 0);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const state = { html: '最新本地内容', overflow: 'false', connected: true, calls: 0, frames: 0 };
  const fonts = { ready: Promise.resolve(), status: 'loaded', load: async () => [] };
  const images: Array<{ decode: () => Promise<void> }> = [];
  const pages = { get innerHTML() { return state.html; }, textContent: '最新本地内容',
    querySelector: () => ({}), querySelectorAll: () => images };
  const preview = { dataset: { fontId: 'sans', get overflow() { return state.overflow; } }, querySelector: () => pages };
  const root = { get isConnected() { return state.connected; }, querySelector: () => preview, ownerDocument: { fonts } } as unknown as HTMLElement;
  const target = { print: () => { state.calls++; }, getComputedStyle: () => ({ fontSize: '14px', fontFamily: 'sans-serif' }),
    requestAnimationFrame: (callback: () => void) => { state.frames++; queueMicrotask(callback); return state.frames; } } as unknown as Window;
  return { root, target, state, fonts, images, preview };
}

test('printing waits for fonts and photo decode before opening the dialog', async () => {
  const f = fixture();
  const font = deferred();
  const photo = deferred();
  f.fonts.ready = font.promise;
  f.images.push({ decode: () => photo.promise });
  const pending = printResumePreview(f.root, f.target);
  await Promise.resolve();
  assert.equal(f.state.calls, 0);
  font.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.calls, 0, 'pending image blocks printing');
  photo.resolve();
  await pending;
  assert.equal(f.state.calls, 1);
  assert.ok(f.state.frames >= 2, 'allow font-driven React pagination to settle');
});

test('broken photos fail without printing and the same preview can retry', async () => {
  const f = fixture();
  f.images.push({ decode: async () => { throw new Error('decode failed'); } });
  await assert.rejects(printResumePreview(f.root, f.target), /图片加载失败/);
  assert.equal(f.state.calls, 0);
  f.images[0].decode = async () => {};
  await printResumePreview(f.root, f.target);
  assert.equal(f.state.calls, 1);
});

test('printing rechecks overflow after asynchronous font preparation', async () => {
  const f = fixture();
  const font = deferred();
  f.fonts.ready = font.promise;
  const pending = printResumePreview(f.root, f.target);
  f.state.overflow = 'true';
  font.resolve();
  await assert.rejects(pending, /内容超过单页高度/);
  assert.equal(f.state.calls, 0);
});

test('printing waits for the replacement pagination fragment to settle', async () => {
  const f = fixture();
  f.target.requestAnimationFrame = callback => {
    f.state.frames++;
    if (f.state.frames === 1) f.state.html = '字体加载后的重新分页';
    queueMicrotask(() => callback(0));
    return f.state.frames;
  };
  await printResumePreview(f.root, f.target);
  assert.equal(f.state.calls, 1);
  assert.ok(f.state.frames >= 4);
});

test('timed out font preparation never opens a delayed dialog', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const font = deferred();
  f.fonts.ready = font.promise;
  const pending = printResumePreview(f.root, f.target);
  const rejected = assert.rejects(pending, /超时/);
  context.mock.timers.tick(15_000);
  await rejected;
  font.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.calls, 0, 'a late font completion must not print after failure');
});


test('font changes during preparation require another stable pagination pass', async () => {
  const f = fixture();
  f.target.requestAnimationFrame = callback => {
    f.state.frames++;
    if (f.state.frames === 1) f.preview.dataset.fontId = 'arial';
    queueMicrotask(() => callback(0));
    return f.state.frames;
  };
  await printResumePreview(f.root, f.target);
  assert.equal(f.state.calls, 1);
  assert.ok(f.state.frames >= 4, 'a new font must be prepared even if the HTML is unchanged');
});
