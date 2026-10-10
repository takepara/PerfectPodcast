import {
  BYTES_PER_FRAME, WAV_HEADER_BYTES, makePcm24WavHeader,
  validWavHeader, validWavSize, wavByteLength
} from './wav-format.js';

const MAX_WAV_BYTES = 1024 * 1024 * 1024;

export function makeWavHeader(frameCount) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('The WAV frame count is invalid.');
  }
  if (wavByteLength(frameCount) > MAX_WAV_BYTES || frameCount * BYTES_PER_FRAME > 0xffffffff - 36) {
    throw new RangeError('The WAV exceeds the 1 GiB output limit.');
  }
  return makePcm24WavHeader(frameCount);
}

export function createPcm24Wav(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('The PCM24 WAV sample is invalid.');
  }
  const data = new ArrayBuffer(samples.length * BYTES_PER_FRAME);
  const view = new DataView(data);
  let offset = 0;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0
      ? Math.round(clamped * 8_388_608)
      : Math.min(8_388_607, Math.round(clamped * 8_388_607));
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
    offset += BYTES_PER_FRAME;
  }
  return new Blob([makeWavHeader(samples.length), data], { type: 'audio/wav' });
}

function validateChunkHeader(chunk, sequence, startFrame) {
  if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== sequence ||
      !Number.isSafeInteger(chunk.startFrame) || chunk.startFrame !== startFrame ||
      !Number.isSafeInteger(chunk.frames) || chunk.frames <= 0 ||
      !(chunk.wav instanceof Blob) || !validWavSize(chunk.wav.size, chunk.frames) ||
      chunk.byteLength !== chunk.wav.size) {
    throw new Error(`The ledger or size of saved chunk ${sequence} is invalid.`);
  }
}

export async function writePcm24Wav(take, chunks, writable) {
  if (!take || !Number.isSafeInteger(take.frames) || take.frames <= 0 ||
      !Array.isArray(chunks) || !writable || typeof writable.write !== 'function') {
    throw new TypeError('The WAV output data or write destination is invalid.');
  }
  const totalBytes = wavByteLength(take.frames);
  if (totalBytes > MAX_WAV_BYTES || totalBytes > 0xffffffff) {
    throw new RangeError('The WAV exceeds the 1 GiB output limit.');
  }

  await writable.write(makeWavHeader(take.frames));
  let writtenFrames = 0;
  for (let sequence = 0; sequence < chunks.length; sequence += 1) {
    const chunk = chunks[sequence];
    validateChunkHeader(chunk, sequence, writtenFrames);
    const header = await chunk.wav.slice(0, WAV_HEADER_BYTES).arrayBuffer();
    if (!validWavHeader(header, chunk.frames)) {
      throw new Error(`The WAV format of saved chunk ${sequence} is invalid.`);
    }
    await writable.write(await chunk.wav.slice(WAV_HEADER_BYTES).arrayBuffer());
    writtenFrames += chunk.frames;
  }
  if (writtenFrames !== take.frames) {
    throw new Error('The frame count in the take ledger does not match the saved chunks.');
  }
}
