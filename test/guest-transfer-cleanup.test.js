import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const recorderSource = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const markStoredFunction = recorderSource.slice(
  recorderSource.indexOf('async function markTransferChunkStored(takeId, sequence, sha256)'),
  recorderSource.indexOf('async function loadTakeChunks(takeId)')
);
const guestTakeValidation = recorderSource.slice(
  recorderSource.indexOf('function guestTakesAreStored(takes)'),
  recorderSource.indexOf('function clearRecordingTrackMonitor()')
);
const guestSessionValidation = recorderSource.slice(
  recorderSource.indexOf('function isGuestLocalSession(session, takes)'),
  recorderSource.indexOf('async function deleteSelectedSessions()')
);

class FakeRequest extends EventTarget {
  constructor(transaction, result) {
    super();
    this.transaction = transaction;
    this.result = result;
    transaction.pending += 1;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('success'));
      transaction.pending -= 1;
      transaction.completeIfIdle();
    });
  }
}

class FakeTransaction extends EventTarget {
  constructor(data) {
    super();
    this.data = data;
    this.pending = 0;
    this.completed = false;
  }

  objectStore(name) {
    const records = this.data[name];
    return {
      get: (key) => new FakeRequest(this, records.find((record) =>
        (name === 'chunks' ? [record.takeId, record.sequence] : record.id).toString() === key.toString())),
      put: (record) => {
        const key = name === 'chunks'
          ? [record.takeId, record.sequence].toString()
          : record.id;
        const index = records.findIndex((item) => (name === 'chunks'
          ? [item.takeId, item.sequence].toString()
          : item.id) === key);
        if (index === -1) records.push(record);
        else records[index] = record;
      },
      delete: (key) => {
        const index = records.findIndex((record) =>
          (name === 'chunks' ? [record.takeId, record.sequence] : record.id).toString() === key.toString());
        if (index !== -1) records.splice(index, 1);
      }
    };
  }

  completeIfIdle() {
    if (this.pending || this.completed) return;
    this.completed = true;
    queueMicrotask(() => this.dispatchEvent(new Event('complete')));
  }

  abort() {
    queueMicrotask(() => this.dispatchEvent(new Event('abort')));
  }
}

test('deletes host-confirmed guest WAV chunks and keeps a lightweight confirmation ledger', async () => {
  const hash = 'a'.repeat(64);
  const data = {
    chunks: [{
      takeId: 'take-a',
      sequence: 2,
      transferGeneration: 'generation',
      byteLength: 144_044,
      frames: 48_000,
      wav: new Blob([new Uint8Array(144_044)])
    }],
    takes: [{ id: 'take-a', transferGeneration: 'generation', chunks: 3 }]
  };
  const context = vm.createContext({
    database: { transaction: () => new FakeTransaction(data) },
    transactionComplete: (tx) => new Promise((resolve, reject) => {
      tx.addEventListener('complete', resolve, { once: true });
      tx.addEventListener('abort', reject, { once: true });
    }),
    transferProgressCache: null,
    updateTransferProgressCache() {}
  });
  vm.runInContext(markStoredFunction, context);

  await context.markTransferChunkStored('take-a', 2, hash);

  assert.deepEqual(data.chunks, []);
  assert.equal(JSON.stringify(data.takes[0].hostStoredChunks), JSON.stringify([{
    sequence: 2,
    sha256: hash,
    bytes: 144_044,
    frames: 48_000
  }]));
  await context.markTransferChunkStored('take-a', 2, hash);
  assert.equal(data.takes[0].hostStoredChunks.length, 1);
});

test('identifies guest sessions and reports whether all their takes are host-confirmed', () => {
  const context = vm.createContext({});
  vm.runInContext(`${guestTakeValidation}\n${guestSessionValidation}`, context);

  assert.equal(context.guestTakesAreStored([]), true);
  assert.equal(context.guestTakesAreStored([{
    transferGeneration: 'generation',
    status: 'stopped',
    hostStored: true
  }]), true);
  assert.equal(context.guestTakesAreStored([{
    transferGeneration: 'generation',
    status: 'stopped',
    hostStored: false
  }]), false);
  assert.equal(context.guestTakesAreStored([{
    transferGeneration: 'generation',
    status: 'recording',
    hostStored: true
  }]), false);
  assert.equal(context.isGuestLocalSession({ guestSession: true }, []), true);
  assert.equal(context.isGuestLocalSession({}, [{
    remote: false,
    transferGeneration: 'generation'
  }]), true);
  assert.equal(context.isGuestLocalSession({}, [{ remote: true, transferGeneration: 'generation' }]), false);
});
