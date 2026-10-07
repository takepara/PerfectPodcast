import assert from 'node:assert/strict';
import test from 'node:test';
import { canQueueRecordingCommit } from '../prototype/recording-commit-queue.js';

test('allows a minute of queued audio before stopping a persistently stalled writer', () => {
  assert.equal(canQueueRecordingCommit(0, false), true);
  assert.equal(canQueueRecordingCommit(59, false), true);
  assert.equal(canQueueRecordingCommit(60, false), false);
});

test('always queues the final chunk so pending audio can be saved on stop', () => {
  assert.equal(canQueueRecordingCommit(60, true), true);
});

test('rejects invalid pending chunk counts', () => {
  assert.throws(() => canQueueRecordingCommit(-1, false), /保存待ち数が不正/u);
  assert.throws(() => canQueueRecordingCommit(0.5, false), /保存待ち数が不正/u);
});
