// Observation delivery is independent of the unique-post export filter.
// Hashes exclude transport fields. Retrying a saved sample preserves its time.
const SAMPLE_INTERVAL_MS = 5 * 60_000;
const MAX_SAMPLES = 50_000;
const OBSERVATION_FIELDS = new Set([
  'captured_at', 'pooled_at', 'contributed_by', 'metrics', 'source_endpoint',
  'observation_id', '__xtap_image_backfill',
]);

export function exactCounter(value) {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Pure preparation: callers commit samples and queued records in one write. */
export async function prepareObservations(tweets, previous = {}) {
  const samples = new Map(Object.entries(previous));
  const accepted = [];
  let sampled = 0;
  for (const tweet of tweets) {
    const time = Date.parse(tweet.captured_at);
    if (typeof tweet.id !== 'string' || !tweet.id || !Number.isFinite(time)) throw new Error('observation requires a post ID and time');
    const content = Object.fromEntries(Object.entries(tweet).filter(([key]) => !OBSERVATION_FIELDS.has(key)));
    const hash = await digest(content);
    const before = samples.get(tweet.id);
    // A later visit in another interval is useful even when every count is unchanged.
    // Deliver late samples too; time ordering must not erase history.
    if (before?.content === hash && Math.floor(time / SAMPLE_INTERVAL_MS) === Math.floor(before.time / SAMPLE_INTERVAL_MS)) {
      sampled++;
      continue;
    }
    const captured_at = new Date(time).toISOString();
    const observation_id = await digest({ id: tweet.id, captured_at, content: hash, metrics: tweet.metrics ?? null });
    accepted.push({ ...tweet, captured_at, observation_id });
    if (!before || time >= before.time) samples.set(tweet.id, { time, content: hash });
  }
  // Eviction only permits extra sampling; it never deletes queued observations.
  const retained = [...samples].sort((a, b) => b[1].time - a[1].time).slice(0, MAX_SAMPLES);
  return { accepted, samples: Object.fromEntries(retained), sampled };
}
