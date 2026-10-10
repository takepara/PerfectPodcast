export const SAMPLE_RATE = 48_000;
export const BYTES_PER_FRAME = 3;
export const WAV_HEADER_BYTES = 44;

export function wavByteLength(frameCount) {
  return WAV_HEADER_BYTES + frameCount * BYTES_PER_FRAME;
}

export function validWavSize(byteLength, frameCount) {
  return Number.isSafeInteger(frameCount) && frameCount > 0 &&
    Number.isSafeInteger(byteLength) && byteLength === wavByteLength(frameCount);
}

function writeText(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function makePcm24WavHeader(frameCount) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('The WAV frame count is invalid.');
  }
  const dataBytes = frameCount * BYTES_PER_FRAME;
  if (dataBytes > 0xffffffff - 36) {
    throw new RangeError('The WAV exceeds the RIFF size limit.');
  }
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
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

export function validWavHeader(bytes, frameCount) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 ||
      frameCount * BYTES_PER_FRAME > 0xffffffff - 36 ||
      !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) ||
      bytes.byteLength !== WAV_HEADER_BYTES) return false;
  const view = bytes instanceof ArrayBuffer
    ? new DataView(bytes)
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, false) === 0x52494646 &&
    view.getUint32(4, true) === wavByteLength(frameCount) - 8 &&
    view.getUint32(8, false) === 0x57415645 &&
    view.getUint32(12, false) === 0x666d7420 &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === SAMPLE_RATE &&
    view.getUint32(28, true) === SAMPLE_RATE * BYTES_PER_FRAME &&
    view.getUint16(32, true) === BYTES_PER_FRAME &&
    view.getUint16(34, true) === 24 &&
    view.getUint32(36, false) === 0x64617461 &&
    view.getUint32(40, true) === frameCount * BYTES_PER_FRAME;
}

export function validWavChunk(bytes, frameCount) {
  if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) ||
      !validWavSize(bytes.byteLength, frameCount)) return false;
  const data = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validWavHeader(data.subarray(0, WAV_HEADER_BYTES), frameCount);
}
