const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const compiled = buildSync({ entryPoints: ['workers/ntfy-watch.js'], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(path.join(process.cwd(), 'tests', 'ntfy-watch.bundled.cjs'));
mod._compile(compiled.outputFiles[0].text, mod.filename = mod.id);
const { checkLevel } = mod.exports;

const SNAPSHOT_URL = 'https://snapshot.test/dashboard.json';
const NTFY_URL = 'https://ntfy.test/secret-topic';
const T0 = Date.parse('2026-10-10T00:00:00Z');
const MINUTE = 60_000;
const originalFetch = global.fetch;
let store, env, sent, snapshotResponse, ntfyStatus;

function snapshotAt(time, level, generatedAt = time) {
  return () => Response.json({ snapshotGeneratedAt: new Date(generatedAt).toISOString(),
    liveStatus: { latestSampledAt: new Date(time).toISOString() },
    signals: { composite: { emergencyLevel: level, actualConcurrentCount: 521, expectedConcurrentCount: 400.4 } } });
}

beforeEach(() => {
  store = new Map(); sent = []; ntfyStatus = 200;
  env = { EWS_SNAPSHOT_URL: SNAPSHOT_URL, EWS_PUBLIC_URL: 'https://ews.kylemcdonald.net/', EWS_MIN_LEVEL: '3',
    EWS_STALE_AFTER_MINUTES: '180', NTFY_SERVER: 'https://ntfy.test', NTFY_TOPIC: 'secret-topic',
    EWS_WATCH_KV: {
      async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async put(key, value) { store.set(key, value); },
    } };
  // No network passthrough: any unexpected fetch fails the test.
  global.fetch = async (url, options) => {
    if (String(url) === SNAPSHOT_URL) return snapshotResponse();
    assert.equal(String(url), NTFY_URL, `Unexpected network request blocked: ${url}`);
    sent.push({ ...options.headers, body: options.body });
    return new Response(null, { status: ntfyStatus });
  };
});
after(() => { global.fetch = originalFetch; });

test('levels below the minimum do not notify', async () => {
  snapshotResponse = snapshotAt(T0 + MINUTE, 2);
  assert.deepEqual(await checkLevel(env, T0), { level: 2, notified: false });
  assert.equal(sent.length, 0);
});

test('reaching level 3 notifies once with the dashboard URL', async () => {
  snapshotResponse = snapshotAt(T0 + MINUTE, 3);
  await checkLevel(env, T0);
  await checkLevel(env, T0 + 10 * MINUTE);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'EWS emergency level 3');
  assert.equal(sent[0].priority, '3');
  assert.equal(sent[0].click, 'https://ews.kylemcdonald.net/');
  assert.equal(sent[0].body, '521 airborne (+121 above expected)\nhttps://ews.kylemcdonald.net/');
});

test('each further increase notifies; decreases and repeats do not', async () => {
  const levels = [3, 4, 4, 3, 5, 2, 3];
  for (const [index, level] of levels.entries()) {
    snapshotResponse = snapshotAt(T0 + (index + 1) * 30 * MINUTE, level);
    await checkLevel(env, T0 + (index + 1) * 30 * MINUTE);
  }
  assert.deepEqual(sent.map(x => x.title), [3, 4, 5, 3].map(level => `EWS emergency level ${level}`));
  assert.equal(sent[2].tags, 'rotating_light');
});

test('a failed ntfy send is retried on the next run', async () => {
  snapshotResponse = snapshotAt(T0 + MINUTE, 4);
  ntfyStatus = 500;
  await assert.rejects(checkLevel(env, T0), /ntfy returned HTTP 500/);
  ntfyStatus = 200;
  assert.equal((await checkLevel(env, T0 + 10 * MINUTE)).notified, true);
  assert.equal(sent.length, 2);
});

test('a stalled or unreachable snapshot warns once, then reports recovery', async () => {
  snapshotResponse = snapshotAt(T0 + MINUTE, 1);
  await checkLevel(env, T0 + MINUTE);
  await checkLevel(env, T0 + 170 * MINUTE);
  assert.equal(sent.length, 0);
  snapshotResponse = () => new Response('gone', { status: 404 });
  await checkLevel(env, T0 + 190 * MINUTE);
  await checkLevel(env, T0 + 200 * MINUTE);
  assert.deepEqual(sent.map(x => x.title), ['EWS snapshot stopped updating']);
  snapshotResponse = snapshotAt(T0 + 300 * MINUTE, 1);
  await checkLevel(env, T0 + 300 * MINUTE);
  assert.equal(sent[1].title, 'EWS snapshot is updating again');
});

test('re-exported old observations still go stale and do not count as recovery', async () => {
  snapshotResponse = snapshotAt(T0, 1);
  await checkLevel(env, T0 + MINUTE);
  for (const minutes of [60, 190, 400]) {
    snapshotResponse = snapshotAt(T0, 4, T0 + minutes * MINUTE);
    await checkLevel(env, T0 + minutes * MINUTE);
  }
  assert.deepEqual(sent.map(x => x.title), ['EWS snapshot stopped updating']);
});

test('a newer observation that is already too old does not alert', async () => {
  snapshotResponse = snapshotAt(T0, 1);
  await checkLevel(env, T0 + MINUTE);
  snapshotResponse = snapshotAt(T0 + 30 * MINUTE, 5, T0 + 600 * MINUTE);
  await checkLevel(env, T0 + 600 * MINUTE);
  assert.deepEqual(sent.map(x => x.title), ['EWS snapshot stopped updating']);
});

test('state saved by the earlier version keeps its level and still alerts', async () => {
  store.set('state', JSON.stringify({ level: 3, generatedAt: T0, staleNotified: false }));
  snapshotResponse = snapshotAt(T0 + MINUTE, 3);
  await checkLevel(env, T0 + 2 * MINUTE);
  snapshotResponse = snapshotAt(T0 + 31 * MINUTE, 4);
  await checkLevel(env, T0 + 32 * MINUTE);
  assert.deepEqual(sent.map(x => x.title), ['EWS emergency level 4']);
});

test('a snapshot that is unreachable from the first run still warns', async () => {
  snapshotResponse = () => { throw new Error('connection refused'); };
  await checkLevel(env, T0);
  assert.equal(sent.length, 0);
  await checkLevel(env, T0 + 181 * MINUTE);
  assert.deepEqual(sent.map(x => x.title), ['EWS snapshot stopped updating']);
});
