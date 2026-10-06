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
      throw new Error('この端末の回収台帳が不正です。');
    }
    const key = inventoryKey(item);
    if (local.has(key)) throw new Error('この端末の回収台帳に重複があります。');
    local.set(key, item);
  }
  for (const item of hostItems) {
    if (!item || typeof item.takeId !== 'string' ||
        (item.kind === 'chunk' &&
          (!Number.isSafeInteger(item.sequence) || item.sequence < 0 ||
           !CHUNK_HASH.test(item.sha256 || ''))) ||
        (item.kind !== 'chunk' && item.kind !== 'manifest')) {
      throw new Error('ホストの回収台帳が不正です。');
    }
    const key = inventoryKey(item);
    if (host.has(key)) throw new Error('ホストの回収台帳に重複があります。');
    host.set(key, item);
  }

  for (const [key, item] of host) {
    const source = local.get(key);
    if (!source) throw new Error('ホストにこの端末では確認できない保存データがあります。');
    if (item.kind === 'chunk' && source.sha256 !== item.sha256) {
      throw new Error(`take ${item.takeId} のチャンク ${item.sequence + 1} で保存hashが一致しません。`);
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
