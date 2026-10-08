import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  verifyIncomingStoredChunk,
  verifyIncomingStoredTake
} from '../prototype/recording-storage.js';
import { makeWavHeader } from '../prototype/wav-export.js';

const take = {
  id: 'remote-generation-take',
  sourceTakeId: '123e4567-e89b-42d3-a456-426614174000',
  transferGeneration: 'generation',
  remote: true,
  frames: 2,
  chunks: 2
};

function storedChunk(sequence, startFrame, pcm) {
  const wav = new Blob([makeWavHeader(pcm.length / 3), pcm]);
  return wav.arrayBuffer().then((arrayBuffer) => ({
    takeId: take.id,
    sourceTakeId: take.sourceTakeId,
    transferGeneration: take.transferGeneration,
    sequence,
    startFrame,
    frames: pcm.length / 3,
    byteLength: wav.size,
    wav,
    sha256: createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex'),
    remote: true,
    hostStored: true
  }));
}

test('verifies received take chunks using their IndexedDB WAV data and hashes', async () => {
  const chunks = [
    await storedChunk(0, 0, new Uint8Array([1, 2, 3])),
    await storedChunk(1, 1, new Uint8Array([4, 5, 6]))
  ];
  const result = await verifyIncomingStoredTake(take, chunks);
  assert.deepEqual(result.map((chunk) => chunk.sequence), [0, 1]);
});

test('rejects missing, altered, or discontinuous IndexedDB chunks', async () => {
  const chunks = [
    await storedChunk(0, 0, new Uint8Array([1, 2, 3])),
    await storedChunk(1, 1, new Uint8Array([4, 5, 6]))
  ];
  await assert.rejects(verifyIncomingStoredTake(take, chunks.slice(0, 1)), /number of received takes and chunks/u);
  await assert.rejects(verifyIncomingStoredTake(take, [chunks[0], { ...chunks[1], startFrame: 2 }]), /ledger .* is invalid/u);
  await assert.rejects(
    verifyIncomingStoredChunk(take, { ...chunks[0], wav: new Blob([new Uint8Array([0])]) }, 0),
    /ledger .* is invalid/u
  );
});
