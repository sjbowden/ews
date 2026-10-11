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
  // State saved before observedAt existed has neither field, so both fall back.
  const state = { observedAt: 0, watchingSince: now, ...(stored || { level: 1, staleNotified: false }) };
  const staleAfterMs = Number(env.EWS_STALE_AFTER_MINUTES) * 60_000;
  let snapshot = null;
  try { snapshot = await fetchSnapshot(env); } catch (error) { console.error('Snapshot fetch failed:', error.message); }

  // Freshness follows the observation time: snapshotGeneratedAt also advances when old data is re-exported.
  const observedAt = Date.parse(snapshot?.liveStatus?.latestSampledAt);
  if (observedAt > state.observedAt && now - observedAt <= staleAfterMs) {
    const level = readLevel(snapshot);
    // State is saved only after ntfy accepts, so a failed notification retries on the next run.
    if (level >= Number(env.EWS_MIN_LEVEL) && level > state.level) {
      await notify(env, { title: `EWS emergency level ${level}`, message: formatLevelMessage(snapshot, env),
        priority: level, tags: level >= 5 ? 'rotating_light' : 'warning' });
    } else if (state.staleNotified) {
      await notify(env, { title: 'EWS snapshot is updating again', message: `Level ${level}\n${env.EWS_PUBLIC_URL}`,
        priority: 2, tags: 'white_check_mark' });
    }
    await env.EWS_WATCH_KV.put(STATE_KEY, JSON.stringify({ level, observedAt, staleNotified: false }));
    return { level, notified: level >= Number(env.EWS_MIN_LEVEL) && level > state.level };
  }

  const lastUpdateAt = state.observedAt || state.watchingSince;
  const stale = now - lastUpdateAt > staleAfterMs;
  if (stale && !state.staleNotified) {
    await notify(env, { title: 'EWS snapshot stopped updating',
      message: `No new aircraft data since ${new Date(lastUpdateAt).toISOString()}. Level alerts are paused.\n${env.EWS_PUBLIC_URL}`,
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
