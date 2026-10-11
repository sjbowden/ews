const STATE_KEY = 'state';

function readLevel(snapshot) {
  const signal = snapshot?.signals?.composite ?? snapshot?.current;
  return Math.round(Number(signal?.emergencyLevel || 1));
}

function formatLevelMessage(snapshot, env) {
  const signal = snapshot?.signals?.composite;
  const actual = Math.round(Number(signal?.actualConcurrentCount ?? snapshot?.current?.concurrentCount ?? 0));
  const expected = Math.round(Number(signal?.expectedConcurrentCount ?? snapshot?.current?.baselineMean ?? 0));
  const excess = actual - expected;
  return `${actual} airborne (${excess >= 0 ? '+' : ''}${excess} above expected)\n${env.EWS_PUBLIC_URL}`;
}

async function fetchSnapshot(env) {
  const response = await fetch(env.EWS_SNAPSHOT_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Snapshot returned HTTP ${response.status}`);
  return response.json();
}

async function notify(env, { title, message, priority, tags }) {
  const response = await fetch(`${env.NTFY_SERVER}/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: { title, priority: String(priority), tags, click: env.EWS_PUBLIC_URL },
    body: message,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
}

export async function checkLevel(env, now = Date.now()) {
  const stored = await env.EWS_WATCH_KV.get(STATE_KEY, 'json');
  // watchingSince starts the staleness clock when no snapshot has ever been seen.
  const state = stored || { level: 1, generatedAt: 0, watchingSince: now, staleNotified: false };
  let snapshot = null;
  try { snapshot = await fetchSnapshot(env); } catch (error) { console.error('Snapshot fetch failed:', error.message); }

  const generatedAt = Date.parse(snapshot?.snapshotGeneratedAt);
  if (generatedAt > state.generatedAt) {
    const level = readLevel(snapshot);
    // State is saved only after ntfy accepts, so a failed notification retries on the next run.
    if (level >= Number(env.EWS_MIN_LEVEL) && level > state.level) {
      await notify(env, { title: `EWS emergency level ${level}`, message: formatLevelMessage(snapshot, env),
        priority: level, tags: level >= 5 ? 'rotating_light' : 'warning' });
    } else if (state.staleNotified) {
      await notify(env, { title: 'EWS snapshot is updating again', message: `Level ${level}\n${env.EWS_PUBLIC_URL}`,
        priority: 2, tags: 'white_check_mark' });
    }
    await env.EWS_WATCH_KV.put(STATE_KEY, JSON.stringify({ level, generatedAt, staleNotified: false }));
    return { level, notified: level >= Number(env.EWS_MIN_LEVEL) && level > state.level };
  }

  const lastUpdateAt = state.generatedAt || state.watchingSince;
  const stale = now - lastUpdateAt > Number(env.EWS_STALE_AFTER_MINUTES) * 60_000;
  if (stale && !state.staleNotified) {
    await notify(env, { title: 'EWS snapshot stopped updating',
      message: `No new snapshot since ${new Date(lastUpdateAt).toISOString()}. Level alerts are paused.\n${env.EWS_PUBLIC_URL}`,
      priority: 3, tags: 'hourglass' });
    await env.EWS_WATCH_KV.put(STATE_KEY, JSON.stringify({ ...state, staleNotified: true }));
  } else if (!stored) {
    await env.EWS_WATCH_KV.put(STATE_KEY, JSON.stringify(state));
  }
  return { level: state.level, notified: false, stale };
}

export default {
  async scheduled(_controller, env) {
    await checkLevel(env);
  },
};
