import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { mergeRecordingMetadata, synchronizationForTake } from '../prototype/recording-ledger.js';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const commitSource = source.slice(source.indexOf('async function commitChunk('), source.indexOf('\nfunction queueRecordingMetadata'));
const queueSource = source.slice(source.indexOf('function queueRecordingMetadata('), source.indexOf('\nasync function createTake('));

function setup() {
  const stored = new Map([['take', { id: 'take', frames: 0, chunks: 0, bytes: 0, hostStoredChunks: [{ sequence: 4 }] }]]);
  const transactions = [];
  const context = vm.createContext({
    mergeRecordingMetadata, activeTake: structuredClone(stored.get('take')),
    capturedFrames: 0, pendingCommits: 0, nextSequence: 0,
    commitChain: Promise.resolve(), commitError: null,
    canQueueRecordingCommit: () => true,
    createPcm24Wav: () => ({ size: 47 }),
    transactionComplete: (transaction) => transaction.done,
    updateTransferProgressCache() {}, scheduleTakeRefresh() {},
    appendNetworkEvent() {}, roomCall: null, $: () => ({}),
    database: { transaction() {
      let release;
      const transaction = { writes: [], done: new Promise((resolve) => { release = resolve; }),
        finish() { for (const value of this.writes) stored.set(value.id, structuredClone(value)); release(); },
        abort() { assert.fail('unexpected abort'); },
        objectStore(name) { return { put(value) { if (name === 'takes') transaction.writes.push(value); },
          get(id) { return { result: stored.get(id), addEventListener(_event, callback) { callback(); } }; }
        }; }
      };
      transactions.push(transaction);
      return transaction;
    } }
  });
  vm.runInContext(commitSource + '\n' + queueSource, context);
  return { context, transactions, stored };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('start observation arriving during a delayed chunk transaction survives memory replacement and later commits', async () => {
  const { context, transactions, stored } = setup();
  const pending = context.commitChunk(new Float32Array(1), false, 0);
  await tick();
  context.activeTake.startObservation = { frame: 0, localPerfMs: 1000, contextTime: 1 };
  context.queueRecordingMetadata({ startObservation: context.activeTake.startObservation });
  transactions[0].finish();
  await pending;
  assert.equal(context.activeTake.startObservation.frame, 0);
  await tick();
  transactions[1].finish();
  await context.commitChain;
  const next = context.commitChunk(new Float32Array(1), true, 1);
  await tick(); transactions[2].finish(); await next;
  assert.equal(stored.get('take').startObservation.frame, 0);
  assert.equal(stored.get('take').frames, 2);
  assert.equal(stored.get('take').hostStoredChunks.length, 1);
});

test('a stale metadata update preserves counters, start observation and confirmed transfer entries', () => {
  const stored = { id: 'take', frames: 200, startObservation: { frame: 0, localPerfMs: 1000, contextTime: 1 },
    hostStoredChunks: [{ sequence: 0 }], synchronization: { differenceMs: -0.1 } };
  const result = mergeRecordingMetadata(stored, { id: 'take', frames: 0 });
  assert.equal(result.frames, 200);
  assert.equal(result.startObservation.frame, 0);
  assert.equal(result.hostStoredChunks.length, 1);
  assert.equal(result.synchronization.differenceMs, -0.1);
});

test('late guest rows resolve persisted host synchronization after reload without crossing sessions or sequences', () => {
  const host = { id: 'host', sessionId: 'session', startPlan: { eventId: 'event', sequence: 1 },
    synchronization: { differenceMs: -0.1 } };
  const guest = { id: 'guest', remote: true, sessionId: 'session', startPlan: host.startPlan };
  assert.equal(synchronizationForTake(guest, [host]).differenceMs, -0.1);
  assert.equal(synchronizationForTake({ ...guest, sessionId: 'another' }, [host]), null);
  assert.equal(synchronizationForTake({ ...guest, startPlan: { eventId: 'event', sequence: 2 } }, [host]), null);
});
