const SAMPLE_RATE = 48_000;
const BYTES_PER_FRAME = 3;
const MAX_WAV_BYTES = 1024 * 1024 * 1024;

function writeText(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function makeWavHeader(frameCount) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('The WAV frame count is invalid.');
  }
  const dataBytes = frameCount * BYTES_PER_FRAME;
  if (44 + dataBytes > MAX_WAV_BYTES || dataBytes > 0xffffffff - 36) {
    throw new RangeError('The WAV exceeds the 1 GiB output limit.');
  }
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  writeText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(view, 8, 'WAVE');
  writeText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_FRAME, true);
  view.setUint16(32, BYTES_PER_FRAME, true);
  view.setUint16(34, 24, true);
  writeText(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
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
      !(chunk.wav instanceof Blob) || chunk.wav.size !== 44 + chunk.frames * BYTES_PER_FRAME ||
      chunk.byteLength !== chunk.wav.size) {
    throw new Error(`The ledger or size of saved chunk ${sequence} is invalid.`);
  }
}

export async function writePcm24Wav(take, chunks, writable) {
  if (!take || !Number.isSafeInteger(take.frames) || take.frames <= 0 ||
      !Array.isArray(chunks) || !writable || typeof writable.write !== 'function') {
    throw new TypeError('The WAV output data or write destination is invalid.');
  }
  const totalBytes = 44 + take.frames * BYTES_PER_FRAME;
  if (totalBytes > MAX_WAV_BYTES || totalBytes > 0xffffffff) {
    throw new RangeError('The WAV exceeds the 1 GiB output limit.');
  }

  await writable.write(makeWavHeader(take.frames));
  let writtenFrames = 0;
  for (let sequence = 0; sequence < chunks.length; sequence += 1) {
    const chunk = chunks[sequence];
    validateChunkHeader(chunk, sequence, writtenFrames);
    const header = new DataView(await chunk.wav.slice(0, 44).arrayBuffer());
    if (header.getUint32(0, false) !== 0x52494646 ||
        header.getUint32(4, true) !== chunk.wav.size - 8 ||
        header.getUint32(8, false) !== 0x57415645 ||
        header.getUint32(12, false) !== 0x666d7420 ||
        header.getUint32(16, true) !== 16 ||
        header.getUint32(28, true) !== SAMPLE_RATE * BYTES_PER_FRAME ||
        header.getUint16(32, true) !== BYTES_PER_FRAME ||
        header.getUint32(36, false) !== 0x64617461 ||
        header.getUint32(40, true) !== chunk.frames * BYTES_PER_FRAME ||
        header.getUint16(20, true) !== 1 || header.getUint16(22, true) !== 1 ||
        header.getUint32(24, true) !== SAMPLE_RATE || header.getUint16(34, true) !== 24) {
      throw new Error(`The WAV format of saved chunk ${sequence} is invalid.`);
    }
    await writable.write(await chunk.wav.slice(44).arrayBuffer());
    writtenFrames += chunk.frames;
  }
  if (writtenFrames !== take.frames) {
    throw new Error('The frame count in the take ledger does not match the saved chunks.');
  }
}
