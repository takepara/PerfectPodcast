import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAlignedWaveformPeak, resetWaveformHistory } from '../prototype/waveform-history.js';

function createWaveform() {
  return {
    history: new Float32Array(600),
    historyCount: 0,
    lastSampleIndex: -1,
    recordingStartedAt: null,
    sampledAt: 0,
    startedAt: 0,
    rulerSecond: -1
  };
}

test('aligns local and remote waveform peaks to the same recording time slots', () => {
  const local = createWaveform();
  const remote = createWaveform();
  resetWaveformHistory(local, 100, 100);
  resetWaveformHistory(remote, 100, 100);

  for (const now of [200, 500, 800]) {
    appendAlignedWaveformPeak(local, 0.5, now);
    appendAlignedWaveformPeak(remote, 0.25, now);
  }

  assert.equal(local.historyCount, remote.historyCount);
  assert.equal(local.lastSampleIndex, remote.lastSampleIndex);
  assert.deepEqual(
    [...local.history.slice(0, 7)].map((sample) => sample === 0 ? 0 : 1),
    [...remote.history.slice(0, 7)].map((sample) => sample === 0 ? 0 : 1)
  );
});

test('positions a late participant at the current recording head', () => {
  const waveform = createWaveform();
  resetWaveformHistory(waveform, 100, 1300);
  assert.equal(waveform.historyCount, 12);
  assert.equal(waveform.lastSampleIndex, 11);

  appendAlignedWaveformPeak(waveform, 0.4, 1400);
  assert.equal(waveform.historyCount, 13);
  assert.equal(waveform.lastSampleIndex, 12);
  assert.ok(Math.abs(waveform.history[12] - 0.4) < 1e-6);
});

test('rolls the shared time window forward and disables sampling after stop', () => {
  const waveform = createWaveform();
  resetWaveformHistory(waveform, 0, 0);
  for (let now = 100; now <= 60_000; now += 100) {
    appendAlignedWaveformPeak(waveform, now / 100_000, now);
  }
  appendAlignedWaveformPeak(waveform, 0.9, 60_100);
  assert.ok(Math.abs(waveform.history[0] - 0.002) < 1e-6);
  assert.ok(Math.abs(waveform.history[599] - 0.9) < 1e-6);

  resetWaveformHistory(waveform, null, 600);
  assert.equal(appendAlignedWaveformPeak(waveform, 0.8, 700), false);
  assert.equal(waveform.historyCount, 0);
});
