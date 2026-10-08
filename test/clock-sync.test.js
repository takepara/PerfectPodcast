import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateClockSample, selectClockSample } from '../prototype/clock-sync.js';

test('calculates guest clock offset and network round-trip time', () => {
  assert.deepEqual(calculateClockSample(100, 150, 151, 111), {
    offsetMs: 45,
    roundTripMs: 10
  });
});

test('selects the valid sample with the lowest round-trip time', () => {
  const samples = [
    { offsetMs: 10, roundTripMs: 30 },
    { offsetMs: 20, roundTripMs: 8 },
    { offsetMs: 30, roundTripMs: 18 }
  ];
  assert.equal(selectClockSample(samples, 3), samples[1]);
});

test('rejects insufficient or invalid clock samples', () => {
  assert.throws(() => selectClockSample([], 3), /not enough valid/u);
  assert.throws(() => calculateClockSample(100, 100, 121, 110), /invalid/u);
});
