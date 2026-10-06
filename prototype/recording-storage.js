import { makeWavHeader } from './wav-export.js';

const WAV_HEADER_BYTES = 44;
const BYTES_PER_FRAME = 3;
const MAX_CHUNK_FRAMES = 48_000;

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  const first = new Uint8Array(left);
  const second = new Uint8Array(right);
  return first.every((byte, index) => byte === second[index]);
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyIncomingStoredChunk(take, chunk, sequence, startFrame = null) {
  if (!take || !chunk || take.remote !== true || chunk.remote !== true ||
      chunk.takeId !== take.id || chunk.sourceTakeId !== take.sourceTakeId ||
      chunk.transferGeneration !== take.transferGeneration || chunk.hostStored !== true ||
      chunk.sequence !== sequence || !Number.isSafeInteger(chunk.startFrame) || chunk.startFrame < 0 ||
      (startFrame !== null && chunk.startFrame !== startFrame) ||
      !Number.isSafeInteger(chunk.frames) || chunk.frames < 1 || chunk.frames > MAX_CHUNK_FRAMES ||
      !(chunk.wav instanceof Blob) || chunk.wav.size !== WAV_HEADER_BYTES + chunk.frames * BYTES_PER_FRAME ||
      chunk.byteLength !== chunk.wav.size || !/^[0-9a-f]{64}$/u.test(chunk.sha256 || '')) {
    throw new Error(`IndexedDB内の受信チャンク${sequence + 1}の台帳が不正です。`);
  }
  const bytes = await chunk.wav.arrayBuffer();
  const header = makeWavHeader(chunk.frames);
  if (!bytesEqual(bytes.slice(0, WAV_HEADER_BYTES), header) ||
      await sha256Hex(bytes) !== chunk.sha256) {
    throw new Error(`IndexedDB内の受信チャンク${sequence + 1}を検証できません。`);
  }
  return chunk;
}

export async function verifyIncomingStoredTake(take, chunks) {
  if (!take || !Array.isArray(chunks) || !Number.isSafeInteger(take.chunks) ||
      take.chunks < 1 || chunks.length !== take.chunks ||
      !Number.isSafeInteger(take.frames) || take.frames < 1) {
    throw new Error('IndexedDB内の受信takeとチャンク数が一致しません。');
  }
  const orderedChunks = [...chunks].sort((left, right) => left.sequence - right.sequence);
  let frames = 0;
  for (let sequence = 0; sequence < orderedChunks.length; sequence += 1) {
    const chunk = orderedChunks[sequence];
    await verifyIncomingStoredChunk(take, chunk, sequence, frames);
    frames += chunk.frames;
  }
  if (frames !== take.frames) {
    throw new Error('IndexedDB内の受信takeとチャンクのframe数が一致しません。');
  }
  return orderedChunks;
}
