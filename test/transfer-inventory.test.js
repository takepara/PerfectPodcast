import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTransferInventory } from '../prototype/transfer-inventory.js';

const takeId = '123e4567-e89b-42d3-a456-426614174000';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

test('reconciles host confirmations and schedules missing chunks for resend', () => {
  const result = reconcileTransferInventory([
    { kind: 'chunk', takeId, sequence: 0, sha256: hashA, hostStored: true },
    { kind: 'chunk', takeId, sequence: 1, sha256: hashB, hostStored: true },
    { kind: 'manifest', takeId, hostStored: true }
  ], [
    { kind: 'chunk', takeId, sequence: 0, sha256: hashA },
    { kind: 'manifest', takeId }
  ]);
  assert.deepEqual(result.chunks.map((item) => item.hostStored), [true, false]);
  assert.equal(result.manifests[0].hostStored, true);
});

test('recognizes host persistence when its ACK was lost', () => {
  const result = reconcileTransferInventory([
    { kind: 'chunk', takeId, sequence: 0, sha256: hashA, hostStored: false }
  ], [
    { kind: 'chunk', takeId, sequence: 0, sha256: hashA }
  ]);
  assert.equal(result.chunks[0].hostStored, true);
});

test('rejects conflicting or host-only inventory records', () => {
  assert.throws(
    () => reconcileTransferInventory(
      [{ kind: 'chunk', takeId, sequence: 0, sha256: hashA }],
      [{ kind: 'chunk', takeId, sequence: 0, sha256: hashB }]
    ),
    /saved hash does not match/u
  );
  assert.throws(
    () => reconcileTransferInventory(
      [],
      [{ kind: 'manifest', takeId }]
    ),
    /cannot be verified/u
  );
});
