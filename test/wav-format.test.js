import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SAMPLE_RATE, BYTES_PER_FRAME, WAV_HEADER_BYTES, makePcm24WavHeader,
  validWavHeader, validWavChunk, validWavSize, wavByteLength
} from '../prototype/wav-format.js';
import { makeWavHeader } from '../prototype/wav-export.js';

test('shares the canonical PCM24 mono 48 kHz header without an export policy limit', () => {
  assert.equal(SAMPLE_RATE, 48_000);
  assert.equal(BYTES_PER_FRAME, 3);
  assert.equal(WAV_HEADER_BYTES, 44);
  assert.equal(wavByteLength(2), 50);
  assert.deepEqual(makePcm24WavHeader(2), makeWavHeader(2));
  const beyondExportLimit = Math.floor((1024 ** 3 - WAV_HEADER_BYTES) / BYTES_PER_FRAME) + 1;
  assert.equal(validWavHeader(makePcm24WavHeader(beyondExportLimit), beyondExportLimit), true);
  assert.throws(() => makeWavHeader(beyondExportLimit), /1 GiB output limit/u);
  for (const frames of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => makePcm24WavHeader(frames), RangeError);
  }
});

test('rejects mutations to every canonical header byte and inconsistent sizes', () => {
  const header = new Uint8Array(makePcm24WavHeader(2));
  assert.equal(validWavHeader(header, 2), true);
  for (let offset = 0; offset < WAV_HEADER_BYTES; offset += 1) {
    const altered = header.slice();
    altered[offset] ^= 1;
    assert.equal(validWavHeader(altered, 2), false, `header byte ${offset}`);
  }
  assert.equal(validWavHeader(header, 1), false);
  assert.equal(validWavHeader(header.subarray(0, 43), 2), false);
  assert.equal(validWavHeader(null, 2), false);
  for (const frames of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validWavSize(wavByteLength(frames), frames), false);
    assert.equal(validWavHeader(header, frames), false);
  }
  assert.equal(validWavSize(50, 2), true);
  assert.equal(validWavSize(49, 2), false);
});

test('validates complete WAV buffers and offset views without interpreting PCM payloads', () => {
  const bytes = new Uint8Array(50);
  bytes.set(new Uint8Array(makePcm24WavHeader(2)));
  bytes.set([255, 0, 128, 0, 255, 127], WAV_HEADER_BYTES);
  assert.equal(validWavChunk(bytes.buffer, 2), true);
  const padded = new Uint8Array(58);
  padded.set(bytes, 4);
  assert.equal(validWavChunk(padded.subarray(4, 54), 2), true);
  assert.equal(validWavChunk(new DataView(padded.buffer, 4, 50), 2), true);
  assert.equal(validWavChunk(padded, 2), false);
  assert.equal(validWavChunk(bytes.subarray(0, 49), 2), false);
  assert.equal(validWavChunk(null, 2), false);
});
