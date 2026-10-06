import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SESSION_FRAMES, remainingSessionFrames } from '../prototype/recording-limits.js';

test('limits the combined recording duration in a session to two hours', () => {
  assert.equal(MAX_SESSION_FRAMES, 2 * 60 * 60 * 48_000);
  assert.equal(remainingSessionFrames(0), MAX_SESSION_FRAMES);
  assert.equal(remainingSessionFrames(48_000), MAX_SESSION_FRAMES - 48_000);
  assert.equal(remainingSessionFrames(MAX_SESSION_FRAMES), 0);
  assert.equal(remainingSessionFrames(MAX_SESSION_FRAMES + 1), 0);
});

test('rejects invalid saved frame totals', () => {
  for (const frames of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => remainingSessionFrames(frames), RangeError);
  }
});
