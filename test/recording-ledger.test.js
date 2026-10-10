import assert from 'node:assert/strict';
import test from 'node:test';
import { CommitQueue } from '../prototype/recording-commit-queue.js';
import { createPcm24Wav } from '../prototype/wav-export.js';
import { mergeRecordingMetadata, synchronizationForTake } from '../prototype/recording-ledger.js';

test('public queue keeps delayed commits and start metadata tied to their original take', async () => {
  let stored = { id: 'take', frames: 0, chunks: 0, bytes: 0, hostStoredChunks: [{ sequence: 4 }] };
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const repository = {
    async commitChunk(chunk) {
      await blocked;
      assert.equal(chunk.takeId, stored.id);
      stored = { ...stored, frames: stored.frames + chunk.frames, chunks: stored.chunks + 1, bytes: stored.bytes + chunk.byteLength };
      return { take: stored, chunk, transactionMs: 1 };
    },
    async patchTake(id, patch) { assert.equal(id, stored.id); stored = { ...stored, ...patch }; return stored; }
  };
  const queue = new CommitQueue(repository, 'take');
  const wav = createPcm24Wav(new Float32Array(1));
  const pending = queue.enqueue({ takeId: 'take', sequence: 0, startFrame: 0, frames: 1, wav, byteLength: wav.size, final: false });
  const observation = { frame: 0, localPerfMs: 1000, contextTime: 1 };
  const metadata = queue.patch({ startObservation: observation });
  observation.frame = 99;
  release();
  await Promise.all([pending, metadata]);
  await queue.enqueue({ takeId: 'take', sequence: 1, startFrame: 1, frames: 1, wav, byteLength: wav.size, final: true });
  await queue.drain();
  assert.equal(stored.startObservation.frame, 0);
  assert.equal(stored.frames, 2);
  assert.equal(stored.hostStoredChunks.length, 1);
});

test('a stale metadata update preserves counters, start observation and confirmed transfer entries', () => {
  const stored = { id: 'take', frames: 200, startObservation: { frame: 0, localPerfMs: 1000, contextTime: 1 },
    hostStoredChunks: [{ sequence: 0 }], synchronization: { differenceMs: -0.1 } };
  const result = mergeRecordingMetadata(stored, { id: 'take', frames: 0 });
  assert.equal(result.frames, 200);
  assert.equal(result.startObservation.frame, 0);
  assert.equal(result.hostStoredChunks.length, 1);
  assert.equal(result.synchronization.differenceMs, -0.1);
});

test('late guest rows resolve persisted host synchronization after reload without crossing sessions or sequences', () => {
  const host = { id: 'host', sessionId: 'session', startPlan: { eventId: 'event', sequence: 1 },
    synchronization: { differenceMs: -0.1 } };
  const guest = { id: 'guest', remote: true, sessionId: 'session', startPlan: host.startPlan };
  assert.equal(synchronizationForTake(guest, [host]).differenceMs, -0.1);
  assert.equal(synchronizationForTake({ ...guest, sessionId: 'another' }, [host]), null);
  assert.equal(synchronizationForTake({ ...guest, startPlan: { eventId: 'event', sequence: 2 } }, [host]), null);
});
