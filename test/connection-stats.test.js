import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateIntervalStats } from '../prototype/connection-stats.js';

test('calculates send bitrate, packet loss, and concealed samples from deltas', () => {
  const result = calculateIntervalStats(
    { bytesSent: 1000, packetsReceived: 90, packetsLost: 10, concealedSamples: 40 },
    { bytesSent: 3000, packetsReceived: 180, packetsLost: 20, concealedSamples: 140 },
    1000
  );
  assert.deepEqual(result, {
    bitrateKbps: 16,
    packetLossPercent: 10,
    concealedSamples: 100
  });
});

test('does not report reset counters or unavailable counters as zero', () => {
  const result = calculateIntervalStats(
    { bytesSent: 3000, packetsReceived: 180, packetsLost: 20, concealedSamples: 140 },
    { bytesSent: 500, packetsReceived: 5, packetsLost: 0 },
    1000
  );
  assert.deepEqual(result, {
    bitrateKbps: null,
    packetLossPercent: null,
    concealedSamples: null
  });
});

test('accepts signed cumulative loss counters when their interval delta is valid', () => {
  const result = calculateIntervalStats(
    { packetsReceived: 10, packetsLost: -2 },
    { packetsReceived: 20, packetsLost: 1 },
    1000
  );
  assert.equal(result.packetLossPercent, 3 / 13 * 100);
});

test('does not calculate rates without a valid baseline or elapsed interval', () => {
  const current = { bytesSent: 20, packetsReceived: 2, packetsLost: 0 };
  assert.deepEqual(calculateIntervalStats(null, current, 1000), {
    bitrateKbps: null,
    packetLossPercent: null,
    concealedSamples: null
  });
  assert.deepEqual(calculateIntervalStats(current, current, 0), {
    bitrateKbps: null,
    packetLossPercent: null,
    concealedSamples: null
  });
});
