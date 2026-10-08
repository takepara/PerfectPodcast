import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcm24Wav, makeWavHeader, writePcm24Wav } from '../prototype/wav-export.js';

function makeChunk(sequence, startFrame, values) {
  const frames = values.length / 3;
  const wav = new Blob([makeWavHeader(frames), Uint8Array.from(values)]);
  return { sequence, startFrame, frames, byteLength: wav.size, wav };
}

test('writes one PCM24 WAV header and consecutive chunk payloads', async () => {
  const writes = [];
  const chunks = [makeChunk(0, 0, [1, 2, 3]), makeChunk(1, 1, [4, 5, 6])];
  await writePcm24Wav({ frames: 2 }, chunks, {
    async write(value) {
      writes.push(new Uint8Array(value));
    }
  });

  assert.equal(writes.length, 3);
  const header = new DataView(writes[0].buffer, writes[0].byteOffset, writes[0].byteLength);
  assert.equal(header.getUint32(0, false), 0x52494646);
  assert.equal(header.getUint32(40, true), 6);
  assert.deepEqual([...writes[1]], [1, 2, 3]);
  assert.deepEqual([...writes[2]], [4, 5, 6]);
});

test('rejects gaps, altered chunk WAV headers, and inconsistent frame totals', async () => {
  const writable = { async write() {} };
  await assert.rejects(
    writePcm24Wav({ frames: 2 }, [makeChunk(1, 0, [1, 2, 3, 4, 5, 6])], writable),
    /ledger or size.*invalid/u
  );
  const invalidHeaderChunk = makeChunk(0, 0, [1, 2, 3]);
  const invalidHeader = new Uint8Array(await invalidHeaderChunk.wav.arrayBuffer());
  invalidHeader[20] = 3;
  await assert.rejects(
    writePcm24Wav({ frames: 1 }, [{
      ...invalidHeaderChunk,
      wav: new Blob([invalidHeader]),
      byteLength: invalidHeader.byteLength
    }], writable),
    /WAV format.*invalid/u
  );
  await assert.rejects(writePcm24Wav({ frames: 2 }, [makeChunk(0, 0, [1, 2, 3])], writable), /frame count.*does not match/u);
});

test('writes a 44-byte PCM24 mono 48 kHz RIFF header', () => {
  const header = new DataView(makeWavHeader(1));
  assert.equal(header.getUint32(4, true), 39);
  assert.equal(header.getUint16(20, true), 1);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(24, true), 48_000);
  assert.equal(header.getUint32(28, true), 144_000);
  assert.equal(header.getUint16(32, true), 3);
  assert.equal(header.getUint16(34, true), 24);
  assert.throws(() => makeWavHeader(0), RangeError);
});

test('encodes live Float32 samples into a complete PCM24 WAV chunk', async () => {
  const wav = createPcm24Wav(new Float32Array([-1, 0, 1]));
  assert.equal(wav.type, 'audio/wav');
  assert.equal(wav.size, 53);
  assert.deepEqual(
    [...new Uint8Array(await wav.slice(44).arrayBuffer())],
    [0, 0, 128, 0, 0, 0, 255, 255, 127]
  );
  assert.throws(() => createPcm24Wav([]), /PCM24 WAV sample is invalid/u);
});
