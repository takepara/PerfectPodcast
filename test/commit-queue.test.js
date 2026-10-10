import assert from 'node:assert/strict';
import test from 'node:test';
import { CommitQueue, publishRecordingCommit } from '../prototype/recording-commit-queue.js';
import { createPcm24Wav } from '../prototype/wav-export.js';

function chunk(sequence = 0, frames = 48000) {
  const wav = createPcm24Wav(new Float32Array(frames));
  return { takeId: 'take', sequence, startFrame: sequence * frames, frames, byteLength: wav.size, wav, final: false };
}

test('queue snapshots WAV input, drops Float32 samples and measures pending work until transaction completion', async () => {
  let now = 0, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const queue = new CommitQueue({ async commitChunk(input) {
    seen.push(input); await barrier; return { chunk: input, take: { id: input.takeId }, transactionMs: 23 };
  } }, 'take', { now: () => now, onMetrics() { throw new Error('display broken'); } });
  const input = { ...chunk(), samples: new Float32Array(48000) };
  const first = queue.enqueue(input);
  input.frames = 1;
  const second = queue.enqueue(chunk(1));
  now = 2100;
  assert.deepEqual([queue.metrics.pendingChunks, queue.metrics.pendingFrames, queue.metrics.pendingBytes, queue.metrics.oldestWaitMs], [2, 96000, 288088, 2100]);
  await Promise.resolve();
  assert.equal(seen[0].frames, 48000);
  assert.equal('samples' in seen[0], false);
  release(); await Promise.all([first, second]); await queue.drain();
  assert.equal(queue.metrics.pendingChunks, 0);
  assert.equal(queue.metrics.transactionMs, 23);
  assert.equal(queue.metrics.maxPendingFrames, 96000);
  assert.equal(queue.metrics.maxOldestWaitMs, 2100);
});

test('stalled queue retains the 60 chunk cap and admits final audio without changing the cap', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const queue = new CommitQueue({ async commitChunk(input) { await barrier; return { chunk: input, transactionMs: 0 }; } }, 'take');
  const tasks = Array.from({ length: 60 }, (_, sequence) => queue.enqueue(chunk(sequence)));
  assert.equal(queue.metrics.pendingFrames, 2_880_000);
  assert.equal(queue.metrics.pendingBytes, 8_642_640);
  assert.throws(() => queue.enqueue(chunk(60)), /60 chunks/);
  tasks.push(queue.enqueue({ ...chunk(60), final: true }));
  assert.equal(queue.metrics.pendingChunks, 61);
  assert.throws(() => queue.enqueue({ ...chunk(), takeId: 'later' }), /take ID/);
  release(); await Promise.all(tasks); await queue.drain();
});

test('first persistence failure rejects drain, cancels later chunks and releases all pending accounting', async () => {
  let writes = 0;
  const failure = Object.assign(new Error('aborted'), { transactionMs: 7 });
  const queue = new CommitQueue({ async commitChunk() { writes += 1; throw failure; } }, 'take');
  const results = await Promise.allSettled([queue.enqueue(chunk()), queue.enqueue(chunk(1))]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure));
  await assert.rejects(queue.drain(), /aborted/);
  assert.equal(writes, 1);
  assert.equal(queue.metrics.pendingFrames, 0);
  assert.equal(queue.metrics.pendingBytes, 0);
  assert.equal(queue.metrics.transactionMs, 7);
});

test('display and notification failures are separate from persistence and do not block each other', async () => {
  const result = { take: { id: 'take' } };
  const called = [];
  const failures = await publishRecordingCommit(result, {
    update() { called.push('display'); throw new Error('DOM'); },
    notify() { called.push('notification'); throw new Error('channel'); },
    onError() { throw new Error('log'); }
  });
  assert.deepEqual(called, ['display', 'notification']);
  assert.deepEqual(failures.map((failure) => failure.stage), ['display', 'notification']);
  assert.equal(result.take.id, 'take');
});
