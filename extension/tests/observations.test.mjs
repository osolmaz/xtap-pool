import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exactCounter, prepareObservations } from '../lib/observations.js';

const tweet = (patch = {}) => ({ id: '123', text: 'Model release', captured_at: '2026-09-06T00:00:00.000Z', metrics: { likes: 10, format: 'exact-v1' }, ...patch });

describe('observation sampling', () => {
  it('uses the same identity after replay and ignores endpoint differences', async () => {
    const first = await prepareObservations([tweet()]);
    const retry = await prepareObservations([tweet({ source_endpoint: 'different', captured_at: '2026-09-06T02:00:00+02:00' })]);
    assert.equal(first.accepted[0].observation_id, retry.accepted[0].observation_id);
    assert.equal(first.accepted[0].captured_at, retry.accepted[0].captured_at);
  });
  it('preserves two later observations of one post in the same batch', async () => {
    const result = await prepareObservations([tweet(), tweet({ captured_at: '2026-09-06T06:00:00Z' })]);
    assert.equal(result.accepted.length, 2);
    assert.notEqual(result.accepted[0].observation_id, result.accepted[1].observation_id);
  });
  it('retains late arrivals without rolling back the most recent sampling state', async () => {
    const recent = await prepareObservations([tweet({ captured_at: '2026-09-06T06:00:00Z' })]);
    const late = await prepareObservations([tweet()], recent.samples);
    assert.equal(late.accepted.length, 1);
    assert.deepEqual(late.samples, recent.samples);
    assert.equal(late.accepted[0].captured_at, tweet().captured_at);
  });
  it('delivers privacy changes immediately', async () => {
    const first = await prepareObservations([tweet()]);
    const second = await prepareObservations([tweet({ is_subscriber_only: true, captured_at: '2026-09-06T00:01:00Z' })], first.samples);
    assert.equal(second.accepted.length, 1);
  });
  it('does not mutate the previously persisted sampling state', async () => {
    const previous = {};
    await prepareObservations([tweet()], previous);
    assert.deepEqual(previous, {});
  });
  it('rejects invalid observation times before admission', async () => {
    await assert.rejects(prepareObservations([tweet({ captured_at: 'invalid' })]), /time/);
  });
  for (const value of [null, undefined, -1, 1.1, NaN, Infinity, '1.2K', '12abc', Number.MAX_SAFE_INTEGER + 1]) {
    it(`keeps invalid counter ${value} unknown`, () => assert.equal(exactCounter(value), null));
  }
  it('preserves exact zero and decimal integers', () => {
    assert.equal(exactCounter(0), 0);
    assert.equal(exactCounter('0'), 0);
    assert.equal(exactCounter('1234'), 1234);
  });
});
