import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const recorderSource = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const deleteFunction = recorderSource.slice(
  recorderSource.indexOf('async function deleteSessionsAndRecordings(sessionIds)'),
  recorderSource.indexOf('async function persistTake(take)')
);

class FakeTransaction extends EventTarget {
  constructor(data) {
    super();
    this.data = data;
    this.pending = 0;
    this.completed = false;
  }

  objectStore(name) {
    const items = this.data[name];
    return {
      delete: (key) => {
        const index = items.findIndex((item) => (name === 'chunks' ? [item.takeId, item.sequence] : item.id).toString() === key.toString());
        if (index !== -1) items.splice(index, 1);
      },
      index: (indexName) => ({
        openCursor: (range) => {
          const values = items.filter((item) => item[indexName] === range.value);
          const request = new EventTarget();
          let position = 0;
          const dispatch = () => {
            this.pending += 1;
            queueMicrotask(() => {
              request.result = values[position]
                ? {
                    value: values[position],
                    primaryKey: name === 'chunks'
                      ? [values[position].takeId, values[position].sequence]
                      : values[position].id,
                    delete: () => {
                      const current = values[position];
                      const itemIndex = items.indexOf(current);
                      if (itemIndex !== -1) items.splice(itemIndex, 1);
                    },
                    continue: () => {
                      position += 1;
                      dispatch();
                    }
                  }
                : null;
              request.dispatchEvent(new Event('success'));
              this.pending -= 1;
              this.completeIfIdle();
            });
          };
          dispatch();
          return request;
        }
      })
    };
  }

  completeIfIdle() {
    if (this.pending || this.completed) return;
    this.completed = true;
    queueMicrotask(() => this.dispatchEvent(new Event('complete')));
  }

  abort() {
    this.dispatchEvent(new Event('abort'));
  }
}

test('deletes a session and all its takes and chunks without affecting other sessions', async () => {
  const data = {
    sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    takes: [
      { id: 'take-a1', sessionId: 'session-a' },
      { id: 'take-a2', sessionId: 'session-a' },
      { id: 'take-b1', sessionId: 'session-b' }
    ],
    chunks: [
      { takeId: 'take-a1', sequence: 0 },
      { takeId: 'take-a1', sequence: 1 },
      { takeId: 'take-a2', sequence: 0 },
      { takeId: 'take-b1', sequence: 0 }
    ]
  };
  const transaction = new FakeTransaction(data);
  const context = vm.createContext({
    database: { transaction: () => transaction },
    transactionComplete: (tx) => new Promise((resolve, reject) => {
      tx.addEventListener('complete', resolve, { once: true });
      tx.addEventListener('abort', reject, { once: true });
    }),
    IDBKeyRange: { only: (value) => ({ value }) }
  });
  vm.runInContext(deleteFunction, context);
  await context.deleteSessionAndRecordings('session-a');
  assert.deepEqual(data.sessions, [{ id: 'session-b' }]);
  assert.deepEqual(data.takes, [{ id: 'take-b1', sessionId: 'session-b' }]);
  assert.deepEqual(data.chunks, [{ takeId: 'take-b1', sequence: 0 }]);
});

test('deletes multiple sessions and all their recordings in one transaction', async () => {
  const data = {
    sessions: [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
    takes: [
      { id: 'take-a1', sessionId: 'session-a' },
      { id: 'take-b1', sessionId: 'session-b' },
      { id: 'take-c1', sessionId: 'session-c' }
    ],
    chunks: [
      { takeId: 'take-a1', sequence: 0 },
      { takeId: 'take-b1', sequence: 0 },
      { takeId: 'take-c1', sequence: 0 }
    ]
  };
  const context = vm.createContext({
    database: { transaction: () => new FakeTransaction(data) },
    transactionComplete: (tx) => new Promise((resolve, reject) => {
      tx.addEventListener('complete', resolve, { once: true });
      tx.addEventListener('abort', reject, { once: true });
    }),
    IDBKeyRange: { only: (value) => ({ value }) }
  });
  vm.runInContext(deleteFunction, context);
  await context.deleteSessionsAndRecordings(['session-a', 'session-b']);
  assert.deepEqual(data.sessions, [{ id: 'session-c' }]);
  assert.deepEqual(data.takes, [{ id: 'take-c1', sessionId: 'session-c' }]);
  assert.deepEqual(data.chunks, [{ takeId: 'take-c1', sequence: 0 }]);
});
