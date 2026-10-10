import { validWavSize } from './wav-format.js';

export const DB_NAME = 'perfectpodcast-local-v1';
export const DB_VERSION = 3;

export const requestResult = (request) => new Promise((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed')), { once: true });
});

export function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('IndexedDB transaction aborted')), { once: true });
  });
}

export function openDatabase(factory = globalThis.indexedDB, name = DB_NAME) {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('IndexedDB is not available in this browser. Use Chrome or Edge.')); return; }
    const request = factory.open(name, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('takes')) {
        const takes = db.createObjectStore('takes', { keyPath: 'id' });
        takes.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const chunks = db.createObjectStore('chunks', { keyPath: ['takeId', 'sequence'] });
        chunks.createIndex('takeId', 'takeId', { unique: false });
      }
      const takes = request.transaction.objectStore('takes');
      if (!takes.indexNames.contains('transferGeneration')) takes.createIndex('transferGeneration', 'transferGeneration', { unique: false });
      const chunks = request.transaction.objectStore('chunks');
      if (chunks.indexNames.contains('transferState')) chunks.deleteIndex('transferState');
      if (!chunks.indexNames.contains('transferGeneration')) chunks.createIndex('transferGeneration', 'transferGeneration', { unique: false });
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('Unable to open the local recording database.')), { once: true });
    request.addEventListener('blocked', () => reject(new Error('Another tab is blocking the database update. Close the recording tab and reload the page.')), { once: true });
  });
}

export class RecordingRepository {
  constructor(database, { now = () => performance.now() } = {}) {
    this.database = database;
    this.now = now;
  }

  async read(storeName, method, ...args) {
    const transaction = this.database.transaction(storeName, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const result = await requestResult(transaction.objectStore(storeName)[method](...args));
      await done;
      return result;
    } catch (error) { await done.catch(() => {}); throw error; }
  }

  async put(storeName, value) {
    const input = structuredClone(value);
    const transaction = this.database.transaction(storeName, 'readwrite');
    const done = transactionComplete(transaction);
    try { transaction.objectStore(storeName).put(input); }
    catch (error) { transaction.abort(); await done.catch(() => {}); throw error; }
    await done;
    return input;
  }

  async indexValues(storeName, indexName, range, predicate = () => true, project = (value) => value, first = false) {
    const transaction = this.database.transaction(storeName, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const values = await new Promise((resolve, reject) => {
        const result = [];
        const request = transaction.objectStore(storeName).index(indexName).openCursor(range);
        request.addEventListener('error', () => reject(request.error), { once: true });
        request.addEventListener('success', () => {
          const cursor = request.result;
          if (!cursor) { resolve(first ? null : result); return; }
          if (predicate(cursor.value)) {
            if (first) { resolve(project(cursor.value)); return; }
            result.push(project(cursor.value));
          }
          cursor.continue();
        });
      });
      await done;
      return values;
    } catch (error) { await done.catch(() => {}); throw error; }
  }

  listSessionTakes(sessionId) {
    return this.indexValues('takes', 'sessionId', IDBKeyRange.only(sessionId));
  }

  async sessionSummary(sessionId) {
    const takes = await this.listSessionTakes(sessionId);
    return { takes: takes.sort((left, right) => left.startedAt - right.startedAt),
      bytes: takes.reduce((total, take) => total + (take.bytes || 0), 0),
      localFrames: takes.reduce((total, take) => total + (take.remote ? 0 : take.frames || 0), 0) };
  }

  async getTakeChunks(takeId) {
    const chunks = await this.indexValues('chunks', 'takeId', IDBKeyRange.only(takeId));
    return chunks.sort((left, right) => left.sequence - right.sequence);
  }

  async updateTake(takeId, update) {
    const transaction = this.database.transaction('takes', 'readwrite');
    const done = transactionComplete(transaction);
    const store = transaction.objectStore('takes');
    let saved, failure;
    const request = store.get(takeId);
    request.addEventListener('success', () => {
      try {
        if (!request.result) throw new Error('The saved recording take was not found.');
        saved = update(request.result);
        if (!saved || saved.id !== takeId) throw new Error('Recording ledger IDs do not match.');
        store.put(saved);
      } catch (error) { failure = error; transaction.abort(); }
    }, { once: true });
    await done.catch((error) => { throw failure || error; });
    return saved;
  }

  patchTake(takeId, patch) {
    const input = structuredClone(patch);
    if (Object.keys(input).some((key) => ['id', 'frames', 'chunks', 'bytes', 'hostStoredChunks'].includes(key))) {
      throw new Error('Recording counters and ACKs require an atomic repository operation.');
    }
    return this.updateTake(takeId, (stored) => {
      const saved = { ...stored, ...input };
      if ('startObservation' in input) saved.startObservation = stored.startObservation ?? input.startObservation;
      if (saved.startObservation) saved.captureStatus = 'started';
      if ('synchronization' in input && input.synchronization == null) saved.synchronization = stored.synchronization ?? input.synchronization;
      return saved;
    });
  }

  async commitChunk(chunk) {
    const input = structuredClone(chunk);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
        !Number.isSafeInteger(input.frames) || input.frames < 1 || input.frames > 48000 ||
        !Number.isSafeInteger(input.startFrame) || input.startFrame < 0 ||
        !(input.wav instanceof Blob) || input.byteLength !== input.wav.size || !validWavSize(input.byteLength, input.frames)) {
      throw new Error('Invalid recording chunk.');
    }
    const startedAt = this.now();
    const transaction = this.database.transaction(['chunks', 'takes'], 'readwrite');
    const done = transactionComplete(transaction);
    const takes = transaction.objectStore('takes');
    let take, failure;
    const request = takes.get(input.takeId);
    request.addEventListener('success', () => {
      try {
        const stored = request.result;
        if (!stored || stored.chunks !== input.sequence || stored.frames !== input.startFrame) {
          throw new Error('Recording chunk does not follow the saved ledger.');
        }
        take = { ...stored, frames: stored.frames + input.frames,
          chunks: stored.chunks + 1, bytes: stored.bytes + input.byteLength };
        transaction.objectStore('chunks').add(input);
        takes.put(take);
      } catch (error) { failure = error; transaction.abort(); }
    }, { once: true });
    try { await done; }
    catch (error) {
      const reason = failure || error;
      reason.transactionMs = this.now() - startedAt;
      throw reason;
    }
    return { chunk: input, take, transactionMs: this.now() - startedAt };
  }

  async markTransferChunkStored(takeId, sequence, sha256) {
    const transaction = this.database.transaction(['chunks', 'takes'], 'readwrite');
    const done = transactionComplete(transaction);
    const chunks = transaction.objectStore('chunks');
    const takes = transaction.objectStore('takes');
    const chunkRequest = chunks.get([takeId, sequence]);
    const takeRequest = takes.get(takeId);
    let chunkLoaded = false, takeLoaded = false, chunk, take, newlyStoredChunk = null;
    const persistConfirmation = () => {
      if (!chunkLoaded || !takeLoaded) return;
      if (!take) { transaction.abort(); return; }
      const confirmedChunks = Array.isArray(take.hostStoredChunks) ? [...take.hostStoredChunks] : [];
      const existing = confirmedChunks.find((item) => item.sequence === sequence);
      if (existing) { if (existing.sha256 !== sha256) transaction.abort(); return; }
      if (!chunk || (chunk.sha256 && chunk.sha256 !== sha256)) { transaction.abort(); return; }
      newlyStoredChunk = chunk;
      confirmedChunks.push({ sequence, sha256, bytes: chunk.byteLength ?? chunk.wav?.size ?? 0, frames: chunk.frames });
      confirmedChunks.sort((left, right) => left.sequence - right.sequence);
      takes.put({ ...take, hostStoredChunks: confirmedChunks });
      chunks.delete([takeId, sequence]);
    };
    chunkRequest.addEventListener('success', () => { chunk = chunkRequest.result; chunkLoaded = true; persistConfirmation(); }, { once: true });
    takeRequest.addEventListener('success', () => { take = takeRequest.result; takeLoaded = true; persistConfirmation(); }, { once: true });
    await done;
    return newlyStoredChunk;
  }

  async deleteUnstartedTake(takeId) {
    const transaction = this.database.transaction('takes', 'readwrite');
    const done = transactionComplete(transaction);
    transaction.objectStore('takes').delete(takeId);
    await done;
  }

  async recoverInterruptedTakes() {
    const transaction = this.database.transaction('takes', 'readwrite');
    const done = transactionComplete(transaction);
    let recovered = 0;
    const request = transaction.objectStore('takes').openCursor();
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) return;
      const take = cursor.value;
      if (take.status === 'preparing') cursor.delete();
      if (take.status === 'recording') {
        cursor.update({ ...take, status: 'recovered', endedAt: Date.now(), tailUnknown: true,
          recoveryReason: 'The tab or browser closed before recording ended. Recovery includes only confirmed chunks.' });
        recovered += 1;
      }
      cursor.continue();
    });
    await done;
    return recovered;
  }
}
