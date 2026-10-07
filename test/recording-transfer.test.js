import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordingTransfer, takeWithTransferParticipant } from '../prototype/recording-transfer.js';
import { makeWavHeader } from '../prototype/wav-export.js';

class FakeDataChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.peer = null;
  }

  send(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.peer.dispatchEvent(event);
  }
}

test('restores missing legacy transfer participant from its session', () => {
  const take = { id: 'take-id', status: 'stopped' };
  assert.deepEqual(takeWithTransferParticipant(take, 'Guest'), { ...take, participant: 'Guest' });
  assert.throws(() => takeWithTransferParticipant(take, ''), /参加者名/u);
});

test('transfers a verified WAV chunk and waits for the host manifest ACK', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const generation = '0123456789abcdefghij_-';
  const takeId = '123e4567-e89b-42d3-a456-426614174000';
  const wav = new Blob([makeWavHeader(1), new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const take = {
    id: takeId,
    transferGeneration: generation,
    participant: 'Guest',
    number: 1,
    startedAt: 1000,
    frames: 1,
    chunks: 1,
    status: 'stopped',
    tailUnknown: false
  };
  let chunkStored = false;
  let manifestStored = false;
  const received = [];
  const hostChannel = new FakeDataChannel();
  const guestChannel = new FakeDataChannel();
  hostChannel.peer = guestChannel;
  guestChannel.peer = hostChannel;
  const host = new RecordingTransfer({
    role: 'host',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getTransferInventory: async () => [],
    storeChunk: async (metadata, receivedWav) => received.push({ metadata, receivedWav }),
    storeManifest: async (manifest) => { assert.equal(manifest.takeId, takeId); },
    onStatus() {}
  });
  const guest = new RecordingTransfer({
    role: 'guest',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getNextChunk: async () => chunkStored ? null : {
      take,
      chunk: {
        sequence: 0,
        startFrame: 0,
        frames: 1,
        final: true,
        wav
      }
    },
    prepareChunk: async () => {},
    reconcileTransferInventory: async () => {},
    markChunkStored: async () => { chunkStored = true; },
    getNextManifest: async () => chunkStored && !manifestStored ? take : null,
    markManifestStored: async () => { manifestStored = true; },
    onStatus() {}
  });
  guest.setChannel(guestChannel);
  host.setChannel(hostChannel);
  try {
    host.wake();
    guest.wake();
    for (let attempts = 0; attempts < 100 && !manifestStored; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(chunkStored, true);
    assert.equal(manifestStored, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].metadata.sequence, 0);
    assert.equal(received[0].metadata.participant, take.participant);
    assert.equal(received[0].receivedWav.size, wav.size);
  } finally {
    host.close();
    guest.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('rejects WAV payloads whose header or checksum does not match metadata', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const generation = '0123456789abcdefghij_-';
  const hostChannel = new FakeDataChannel();
  const guestChannel = new FakeDataChannel();
  hostChannel.peer = guestChannel;
  guestChannel.peer = hostChannel;
  let stored = false;
  const host = new RecordingTransfer({
    role: 'host',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getTransferInventory: async () => [],
    storeChunk: async () => { stored = true; },
    storeManifest: async () => {},
    onStatus() {}
  });
  const guest = new RecordingTransfer({
    role: 'guest',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getNextChunk: async () => ({
      take: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        transferGeneration: generation,
        participant: 'Guest',
        number: 1,
        startedAt: 1000
      },
      chunk: {
        sequence: 0,
        startFrame: 0,
        frames: 1,
        final: true,
        wav: new Blob([new Uint8Array(47)], { type: 'audio/wav' })
      }
    }),
    prepareChunk: async () => {},
    reconcileTransferInventory: async () => {},
    markChunkStored: async () => {},
    getNextManifest: async () => null,
    markManifestStored: async () => {},
    onStatus() {}
  });
  const errors = [];
  guest.onStatus = (message, isError) => { if (isError) errors.push(message); };
  guest.setChannel(guestChannel);
  host.setChannel(hostChannel);
  try {
    host.wake();
    guest.wake();
    for (let attempts = 0; attempts < 100 && !errors.length; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stored, false);
    assert.equal(errors.length, 1);
  } finally {
    host.close();
    guest.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('retries an unconfirmed chunk without changing its bytes', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (callback, delay) => setTimeout(callback, delay === 30_000 ? 10 : delay),
    clearTimeout
  };
  const generation = '0123456789abcdefghij_-';
  const takeId = '123e4567-e89b-42d3-a456-426614174000';
  const wav = new Blob([makeWavHeader(1), new Uint8Array([7, 8, 9])], { type: 'audio/wav' });
  const take = {
    id: takeId,
    transferGeneration: generation,
    participant: 'Guest',
    number: 1,
    startedAt: 1000,
    frames: 1,
    chunks: 1,
    status: 'stopped',
    tailUnknown: false
  };
  let chunkStored = false;
  let attempts = 0;
  const hostChannel = new FakeDataChannel();
  const guestChannel = new FakeDataChannel();
  hostChannel.peer = guestChannel;
  guestChannel.peer = hostChannel;
  const originalHostSend = hostChannel.send.bind(hostChannel);
  let droppedAck = false;
  hostChannel.send = (data) => {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'chunk-ack' && !droppedAck) {
        droppedAck = true;
        return;
      }
    }
    originalHostSend(data);
  };
  const host = new RecordingTransfer({
    role: 'host',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getTransferInventory: async () => [],
    storeChunk: async (metadata, receivedWav) => {
      attempts += 1;
      assert.equal(metadata.sequence, 0);
      assert.deepEqual(new Uint8Array(await receivedWav.arrayBuffer()), new Uint8Array(await wav.arrayBuffer()));
    },
    storeManifest: async () => {},
    onStatus() {}
  });
  const guest = new RecordingTransfer({
    role: 'guest',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getNextChunk: async () => chunkStored ? null : {
      take,
      chunk: { sequence: 0, startFrame: 0, frames: 1, final: true, wav }
    },
    prepareChunk: async () => {},
    reconcileTransferInventory: async () => {},
    markChunkStored: async () => { chunkStored = true; },
    getNextManifest: async () => null,
    markManifestStored: async () => {},
    onStatus() {}
  });
  guest.setChannel(guestChannel);
  host.setChannel(hostChannel);
  try {
    host.wake();
    guest.wake();
    for (let count = 0; count < 100 && !chunkStored; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(droppedAck, true);
    assert.equal(chunkStored, true);
    assert.equal(attempts, 2);
  } finally {
    host.close();
    guest.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('does not start guest uploads until host inventory reconciliation succeeds', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const generation = '0123456789abcdefghij_-';
  const takeId = '123e4567-e89b-42d3-a456-426614174000';
  const hostChannel = new FakeDataChannel();
  const guestChannel = new FakeDataChannel();
  hostChannel.peer = guestChannel;
  guestChannel.peer = hostChannel;
  let reconciled = false;
  let queriedChunk = false;
  let resolveInventory;
  const host = new RecordingTransfer({
    role: 'host',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getTransferInventory: () => new Promise((resolve) => { resolveInventory = resolve; }),
    onStatus() {}
  });
  const guest = new RecordingTransfer({
    role: 'guest',
    isAuthorized: () => true,
    getGeneration: () => generation,
    getNextChunk: async () => {
      queriedChunk = true;
      return null;
    },
    prepareChunk: async () => {},
    reconcileTransferInventory: async (receivedGeneration, items) => {
      assert.equal(receivedGeneration, generation);
      assert.deepEqual(items, [{ kind: 'manifest', takeId }]);
      reconciled = true;
    },
    onStatus() {}
  });
  guest.setChannel(guestChannel);
  host.setChannel(hostChannel);
  try {
    guest.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queriedChunk, false);
    resolveInventory([{ kind: 'manifest', takeId }]);
    for (let count = 0; count < 100 && !reconciled; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reconciled, true);
    for (let count = 0; count < 100 && !queriedChunk; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queriedChunk, true);
  } finally {
    host.close();
    guest.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
