import assert from 'node:assert/strict';
import test from 'node:test';
import { splitTransferBacklog, summarizeTransferChunks } from '../prototype/transfer-progress.js';

test('separates committed, host-confirmed, and pending transfer volume', () => {
  assert.deepEqual(summarizeTransferChunks([
    { bytes: 144_044, frames: 48_000, hostStored: true },
    { bytes: 72_044, frames: 24_000, hostStored: false }
  ]), {
    bytes: 216_088,
    frames: 72_000,
    hostStoredBytes: 144_044,
    hostStoredFrames: 48_000,
    pendingBytes: 72_044,
    pendingFrames: 24_000
  });
});

test('reports empty transfer progress as zero without inventing throughput', () => {
  assert.deepEqual(summarizeTransferChunks([]), {
    bytes: 0,
    frames: 0,
    hostStoredBytes: 0,
    hostStoredFrames: 0,
    pendingBytes: 0,
    pendingFrames: 0
  });
});

test('rejects invalid chunk measurements instead of reporting them as zero', () => {
  assert.throws(
    () => summarizeTransferChunks([{ bytes: -1, frames: 48_000, hostStored: false }]),
    /チャンク情報が不正/u
  );
  assert.throws(
    () => summarizeTransferChunks([{ bytes: 10, frames: 1, hostStored: null }]),
    /チャンク情報が不正/u
  );
});

test('splits unsubmitted, sending, and acknowledgement-waiting backlog', () => {
  assert.deepEqual(splitTransferBacklog(200, { state: 'sending', bytes: 80 }), {
    unsubmittedBytes: 120,
    sendingBytes: 80,
    awaitingAckBytes: 0
  });
  assert.deepEqual(splitTransferBacklog(200, { state: 'awaiting-ack', bytes: 80 }), {
    unsubmittedBytes: 120,
    sendingBytes: 0,
    awaitingAckBytes: 80
  });
  assert.deepEqual(splitTransferBacklog(20, { state: 'sending', bytes: 80 }), {
    unsubmittedBytes: 0,
    sendingBytes: 20,
    awaitingAckBytes: 0
  });
});

test('rejects malformed send activity when splitting backlog', () => {
  assert.throws(() => splitTransferBacklog(-1, { state: 'idle', bytes: 0 }), /状況が不正/u);
  assert.throws(() => splitTransferBacklog(10, { state: 'unknown', bytes: 0 }), /状況が不正/u);
});
