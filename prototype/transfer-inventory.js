const CHUNK_HASH = /^[0-9a-f]{64}$/u;

function inventoryKey(item) {
  return item.kind === 'chunk'
    ? `chunk:${item.takeId}:${item.sequence}`
    : `manifest:${item.takeId}`;
}

export function reconcileTransferInventory(localItems, hostItems) {
  const local = new Map();
  const host = new Map();
  for (const item of localItems) {
    if (!item || typeof item.takeId !== 'string' ||
        (item.kind === 'chunk' &&
          (!Number.isSafeInteger(item.sequence) || item.sequence < 0 ||
           !CHUNK_HASH.test(item.sha256 || ''))) ||
        (item.kind !== 'chunk' && item.kind !== 'manifest')) {
      throw new Error('The recovery ledger on this device is invalid.');
    }
    const key = inventoryKey(item);
    if (local.has(key)) throw new Error('The recovery ledger on this device contains duplicates.');
    local.set(key, item);
  }
  for (const item of hostItems) {
    if (!item || typeof item.takeId !== 'string' ||
        (item.kind === 'chunk' &&
          (!Number.isSafeInteger(item.sequence) || item.sequence < 0 ||
           !CHUNK_HASH.test(item.sha256 || ''))) ||
        (item.kind !== 'chunk' && item.kind !== 'manifest')) {
      throw new Error('The host recovery ledger is invalid.');
    }
    const key = inventoryKey(item);
    if (host.has(key)) throw new Error('The host recovery ledger contains duplicates.');
    host.set(key, item);
  }

  for (const [key, item] of host) {
    const source = local.get(key);
    if (!source) throw new Error('The host has saved data that cannot be verified on this device.');
    if (item.kind === 'chunk' && source.sha256 !== item.sha256) {
      throw new Error(`The saved hash does not match for chunk ${item.sequence + 1} of take ${item.takeId}.`);
    }
  }

  return {
    chunks: [...local.values()]
      .filter((item) => item.kind === 'chunk')
      .map((item) => ({ ...item, hostStored: host.has(inventoryKey(item)) })),
    manifests: [...local.values()]
      .filter((item) => item.kind === 'manifest')
      .map((item) => ({ ...item, hostStored: host.has(inventoryKey(item)) }))
  };
}
