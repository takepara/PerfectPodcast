const CHUNK_BYTES_PER_FRAME = 3;
const WAV_HEADER_BYTES = 44;
const MAX_CHUNK_FRAMES = 48_000;
const MAX_TAKE_FRAMES = 2 * 60 * 60 * MAX_CHUNK_FRAMES;
const MAX_TAKE_CHUNKS = 2 * 60 * 60;
const MAX_TAKE_NUMBER = 1_000_000;
const MAX_CHUNK_BYTES = WAV_HEADER_BYTES + MAX_CHUNK_FRAMES * CHUNK_BYTES_PER_FRAME;
const MESSAGE_BYTES = 16 * 1024;
const BUFFERED_BYTES_LIMIT = 64 * 1024;
const ACK_TIMEOUT_MS = 30_000;
const MAX_SEND_ATTEMPTS = 3;
const MAX_INVENTORY_ITEMS = 100_000;
const INVENTORY_BATCH_ITEMS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function transferId(takeId, sequence) {
  return `${takeId}:${sequence}`;
}

function sha256Hex(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function validChunkMetadata(message) {
  return UUID_PATTERN.test(message.takeId || '') &&
    Number.isSafeInteger(message.sequence) && message.sequence >= 0 &&
    message.sequence < MAX_TAKE_CHUNKS &&
    Number.isSafeInteger(message.startFrame) && message.startFrame >= 0 &&
    Number.isSafeInteger(message.frames) && message.frames > 0 && message.frames <= MAX_CHUNK_FRAMES &&
    message.startFrame + message.frames <= MAX_TAKE_FRAMES &&
    Number.isSafeInteger(message.totalBytes) &&
    message.totalBytes === WAV_HEADER_BYTES + message.frames * CHUNK_BYTES_PER_FRAME &&
    message.totalBytes <= MAX_CHUNK_BYTES &&
    typeof message.final === 'boolean' && HASH_PATTERN.test(message.sha256 || '') &&
    typeof message.participant === 'string' && message.participant.trim().length > 0 &&
    message.participant.length <= 60 &&
    Number.isSafeInteger(message.takeNumber) && message.takeNumber > 0 &&
    message.takeNumber <= MAX_TAKE_NUMBER &&
    Number.isFinite(message.startedAt) && message.startedAt > 0 &&
    message.startedAt <= 8.64e15;
}

function validWavChunk(bytes, frames) {
  if (bytes.byteLength !== WAV_HEADER_BYTES + frames * CHUNK_BYTES_PER_FRAME) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, WAV_HEADER_BYTES);
  return view.getUint32(0, false) === 0x52494646 &&
    view.getUint32(4, true) === bytes.byteLength - 8 &&
    view.getUint32(8, false) === 0x57415645 &&
    view.getUint32(12, false) === 0x666d7420 &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 48_000 &&
    view.getUint32(28, true) === 144_000 &&
    view.getUint16(32, true) === 3 &&
    view.getUint16(34, true) === 24 &&
    view.getUint32(36, false) === 0x64617461 &&
    view.getUint32(40, true) === frames * CHUNK_BYTES_PER_FRAME;
}

function validManifest(message) {
  return UUID_PATTERN.test(message.takeId || '') &&
    Number.isSafeInteger(message.takeNumber) && message.takeNumber > 0 &&
    message.takeNumber <= MAX_TAKE_NUMBER &&
    typeof message.participant === 'string' && message.participant.trim().length > 0 &&
    message.participant.length <= 60 &&
    Number.isFinite(message.startedAt) && message.startedAt > 0 && message.startedAt <= 8.64e15 &&
    Number.isSafeInteger(message.frames) && message.frames > 0 &&
    Number.isSafeInteger(message.chunks) && message.chunks > 0 &&
    message.frames <= MAX_TAKE_FRAMES &&
    message.chunks <= MAX_TAKE_CHUNKS &&
    ['stopped', 'recovered'].includes(message.status) &&
    typeof message.tailUnknown === 'boolean';
}

export function takeWithTransferParticipant(take, fallbackParticipant) {
  const participant = take.participant ?? fallbackParticipant;
  if (typeof participant !== 'string' || !participant.trim() || participant.length > 60) {
    throw new Error('Unable to restore the participant name for the recording being transferred.');
  }
  return take.participant === participant ? take : { ...take, participant };
}

function validInventoryItem(item) {
  return item && UUID_PATTERN.test(item.takeId || '') &&
    (item.kind === 'manifest' ||
      (item.kind === 'chunk' &&
       Number.isSafeInteger(item.sequence) && item.sequence >= 0 &&
       item.sequence < MAX_TAKE_CHUNKS && HASH_PATTERN.test(item.sha256 || '')));
}

export class RecordingTransfer {
  constructor({
    role,
    isAuthorized,
    getGeneration,
    getNextChunk,
    markChunkStored,
    getNextManifest,
    markManifestStored,
    prepareChunk,
    getTransferInventory,
    reconcileTransferInventory,
    storeChunk,
    storeManifest,
    onStatus
  }) {
    this.role = role;
    this.isAuthorized = isAuthorized;
    this.getGeneration = getGeneration;
    this.getNextChunk = getNextChunk;
    this.markChunkStored = markChunkStored;
    this.getNextManifest = getNextManifest;
    this.markManifestStored = markManifestStored;
    this.prepareChunk = prepareChunk;
    this.getTransferInventory = getTransferInventory;
    this.reconcileTransferInventory = reconcileTransferInventory;
    this.storeChunk = storeChunk;
    this.storeManifest = storeManifest;
    this.onStatus = onStatus;
    this.channel = null;
    this.pendingAcks = new Map();
    this.currentChunk = null;
    this.activeSendProgress = { state: 'idle', bytes: 0 };
    this.receiveChain = Promise.resolve();
    this.transferTask = null;
    this.workRequested = false;
    this.inventoryReady = role !== 'guest';
    this.inventoryRequested = false;
    this.receivedInventory = null;
    this.inventoryTimer = null;
    this.boundOpen = () => this.wake();
    this.boundClose = () => this.rejectPending(new Error('The recovery DataChannel was disconnected.'));
    this.boundMessage = (event) => {
      this.receiveChain = this.receiveChain
        .then(() => this.receive(event.data))
        .catch((error) => this.onStatus(`Unable to process audio recovery: ${error.message}`, true));
    };
  }

  setRole(role) {
    this.role = role;
    this.inventoryReady = role !== 'guest';
    this.inventoryRequested = false;
  }

  setChannel(channel) {
    if (this.channel === channel) return;
    this.detachChannel();
    this.channel = channel;
    this.inventoryReady = this.role !== 'guest';
    this.inventoryRequested = false;
    this.receivedInventory = null;
    window.clearTimeout(this.inventoryTimer);
    this.inventoryTimer = null;
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = MESSAGE_BYTES;
    channel.addEventListener('open', this.boundOpen);
    channel.addEventListener('close', this.boundClose);
    channel.addEventListener('error', this.boundClose);
    channel.addEventListener('message', this.boundMessage);
    if (channel.readyState === 'open') this.wake();
  }

  detachChannel() {
    if (!this.channel) return;
    this.channel.removeEventListener('open', this.boundOpen);
    this.channel.removeEventListener('close', this.boundClose);
    this.channel.removeEventListener('error', this.boundClose);
    this.channel.removeEventListener('message', this.boundMessage);
    this.channel = null;
    this.currentChunk = null;
    this.inventoryReady = this.role !== 'guest';
    this.inventoryRequested = false;
    this.receivedInventory = null;
    window.clearTimeout(this.inventoryTimer);
    this.inventoryTimer = null;
    this.rejectPending(new Error('The recovery DataChannel was disconnected.'));
  }

  isOpen() {
    return this.channel?.readyState === 'open' && this.isAuthorized?.() === true;
  }

  sendData(data) {
    this.channel.send(data);
  }

  wake() {
    this.workRequested = true;
    if (!this.isOpen()) return;
    if (this.role === 'host') {
      if (this.inventoryRequested) return;
      this.inventoryRequested = true;
      void this.sendInventorySnapshot();
      return;
    }
    if (this.role !== 'guest' || !this.inventoryReady || this.transferTask) return;
    this.transferTask = this.drain().catch((error) => {
      this.onStatus(`Unable to transfer audio to the host: ${error.message}`, true);
    }).finally(() => {
      this.transferTask = null;
      if (this.workRequested) this.wake();
    });
  }

  async drain() {
    while (this.isOpen() && this.inventoryReady) {
      this.workRequested = false;
      const pendingChunk = await this.getNextChunk();
      if (pendingChunk) {
        await this.sendChunkWithRetry(pendingChunk);
        continue;
      }
      const pendingManifest = await this.getNextManifest();
      if (pendingManifest) {
        await this.sendManifestWithRetry(pendingManifest);
        continue;
      }
      if (this.workRequested) continue;
      return;
    }
  }

  async sendChunkWithRetry({ take, chunk }) {
    if (!(chunk.wav instanceof Blob) || chunk.wav.size > MAX_CHUNK_BYTES ||
        !Number.isSafeInteger(chunk.frames) || chunk.frames < 1 || chunk.frames > MAX_CHUNK_FRAMES ||
        chunk.wav.size !== WAV_HEADER_BYTES + chunk.frames * CHUNK_BYTES_PER_FRAME ||
        !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 ||
        !Number.isSafeInteger(chunk.startFrame) || chunk.startFrame < 0) {
      throw new Error('The WAV chunk format or size limit for sending is invalid.');
    }
    const bytes = await chunk.wav.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const metadata = {
      type: 'chunk-start',
      generation: take.transferGeneration,
      takeId: take.id,
      sequence: chunk.sequence,
      startFrame: chunk.startFrame,
      frames: chunk.frames,
      final: Boolean(chunk.final),
      totalBytes: bytes.byteLength,
      sha256,
      participant: take.participant,
      takeNumber: take.number,
      startedAt: take.startedAt
    };
    if (!validChunkMetadata(metadata)) throw new Error('The ledger information for the chunk to send is invalid.');
    const id = transferId(take.id, chunk.sequence);
    if (!this.prepareChunk) throw new Error('Unable to save the chunk hash before transfer.');
    await this.prepareChunk(take.id, chunk.sequence, sha256);
    let lastError;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        this.activeSendProgress = { state: 'sending', bytes: bytes.byteLength };
        const ack = this.waitForAck(id, sha256, 'chunk-ack');
        void ack.catch(() => {});
        this.sendControl(metadata);
        for (let offset = 0; offset < bytes.byteLength; offset += MESSAGE_BYTES) {
          const part = bytes.slice(offset, Math.min(offset + MESSAGE_BYTES, bytes.byteLength));
          await this.waitForBufferSpace(part.byteLength);
          this.sendData(part);
          await new Promise((resolve) => window.setTimeout(resolve, 65));
        }
        this.activeSendProgress = { state: 'awaiting-ack', bytes: bytes.byteLength };
        const response = await ack;
        if (!response.accepted) throw new Error(response.message || 'The host could not save the chunk.');
        await this.markChunkStored(take.id, chunk.sequence, sha256);
        this.onStatus(`Saved on the host device · ${take.participant} · chunk ${chunk.sequence + 1}`);
        return;
      } catch (error) {
        lastError = error;
        this.clearPendingAck(id, error);
        if (!this.isOpen()) break;
      } finally {
        this.activeSendProgress = { state: 'idle', bytes: 0 };
      }
    }
    throw lastError || new Error('No chunk save confirmation was received from the host.');
  }

  getSendProgress() {
    return {
      ...this.activeSendProgress,
      bufferedBytes: this.channel?.bufferedAmount ?? 0
    };
  }

  async sendManifestWithRetry(take) {
    const message = {
      type: 'take-manifest',
      generation: take.transferGeneration,
      takeId: take.id,
      takeNumber: take.number,
      participant: take.participant,
      startedAt: take.startedAt,
      frames: take.frames,
      chunks: take.chunks,
      status: take.status,
      tailUnknown: Boolean(take.tailUnknown)
    };
    if (!validManifest(message)) throw new Error('The take manifest is invalid.');
    const id = `manifest:${take.id}`;
    let lastError;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const ack = this.waitForAck(id, '', 'manifest-ack');
        void ack.catch(() => {});
        this.sendControl(message);
        const response = await ack;
        if (!response.accepted) throw new Error(response.message || 'The host could not save the take manifest.');
        await this.markManifestStored(take.id);
        this.onStatus(`All chunks saved on the host device · ${take.participant}`);
        return;
      } catch (error) {
        lastError = error;
        this.clearPendingAck(id, error);
        if (!this.isOpen()) break;
      }
    }
    throw lastError || new Error('No final save confirmation was received from the host.');
  }

  async waitForBufferSpace(bytes) {
    while (this.isOpen() && this.channel.bufferedAmount + bytes > BUFFERED_BYTES_LIMIT) {
      await new Promise((resolve, reject) => {
        const channel = this.channel;
        const cleanup = () => {
          window.clearTimeout(timer);
          channel.removeEventListener('bufferedamountlow', onLow);
          channel.removeEventListener('close', onClose);
        };
        const onLow = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('The recovery DataChannel was disconnected.'));
        };
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('The recovery DataChannel send buffer was not released.'));
        }, 10_000);
        channel.addEventListener('bufferedamountlow', onLow, { once: true });
        channel.addEventListener('close', onClose, { once: true });
        if (channel.bufferedAmount + bytes <= BUFFERED_BYTES_LIMIT) onLow();
      });
    }
    if (!this.isOpen()) throw new Error('The recovery DataChannel is not connected.');
  }

  waitForAck(id, sha256, type) {
    this.clearPendingAck(id);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error('No save confirmation was received from the host.'));
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(id, { sha256, type, resolve, reject, timer });
    });
  }

  clearPendingAck(id, error = null) {
    const pending = this.pendingAcks.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingAcks.delete(id);
    if (error) pending.reject(error);
  }

  rejectPending(error) {
    for (const [id, pending] of this.pendingAcks) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingAcks.delete(id);
    }
  }

  sendControl(message) {
    if (!this.isOpen()) throw new Error('The recovery DataChannel is not connected.');
    this.sendData(JSON.stringify(message));
  }

  async sendInventorySnapshot() {
    const requestId = crypto.randomUUID();
    try {
      if (!this.getTransferInventory) throw new Error('Unable to read the transfer inventory.');
      const items = await this.getTransferInventory(this.generation());
      if (!Array.isArray(items) || items.length > MAX_INVENTORY_ITEMS) {
        throw new Error('The transfer inventory exceeds the limit.');
      }
      this.sendControl({
        type: 'inventory-start',
        generation: this.generation(),
        requestId,
        count: items.length
      });
      for (let offset = 0; offset < items.length; offset += INVENTORY_BATCH_ITEMS) {
        const batch = items.slice(offset, offset + INVENTORY_BATCH_ITEMS);
        if (batch.some((item) => !validInventoryItem(item))) {
          throw new Error('The transfer inventory content is invalid.');
        }
        const message = {
          type: 'inventory-items',
          generation: this.generation(),
          requestId,
          items: batch
        };
        const encoded = JSON.stringify(message);
        await this.waitForBufferSpace(new TextEncoder().encode(encoded).byteLength);
        this.sendData(encoded);
      }
      this.sendControl({
        type: 'inventory-end',
        generation: this.generation(),
        requestId,
        count: items.length
      });
      this.onStatus('Started comparing saved audio on the host with the recovery ledger.');
    } catch (error) {
      this.inventoryRequested = false;
      this.onStatus(`Unable to read the host recovery ledger: ${error.message}`, true);
      try {
        this.sendControl({
          type: 'inventory-start',
          generation: this.generation(),
          requestId,
          count: 0
        });
        this.sendControl({
          type: 'inventory-end',
          generation: this.generation(),
          requestId,
          count: 0
        });
      } catch (sendError) {
        this.onStatus(`Unable to notify the other participant about the recovery inventory failure: ${sendError.message}`, true);
      }
    }
  }

  refreshInventory() {
    if (!this.isOpen()) return;
    if (this.role === 'host') {
      this.inventoryRequested = false;
      this.wake();
    } else if (this.role === 'guest') {
      this.inventoryReady = false;
      try {
        this.sendControl({ type: 'inventory-refresh', generation: this.generation() });
        this.onStatus('Requested that the host reconcile the recovery ledger again.');
      } catch (error) {
        this.onStatus(`Unable to request reconciliation from the host: ${error.message}`, true);
      }
    }
  }

  async receive(data) {
    if (!this.isOpen()) return;
    if (typeof data === 'string') {
      if (data.length > 64 * 1024) throw new Error('The recovery control message exceeds the size limit.');
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        throw new Error('The recovery message format is invalid.');
      }
      await this.receiveControl(message);
      return;
    }
    if (this.role !== 'host') return;
    const bytes = data instanceof ArrayBuffer && data.byteLength <= MESSAGE_BYTES
      ? new Uint8Array(data)
      : data instanceof Blob && data.size <= MESSAGE_BYTES
        ? new Uint8Array(await data.arrayBuffer())
        : null;
    if (!bytes) throw new Error('The recovery data format is invalid.');
    await this.receiveChunkBytes(bytes);
  }

  async receiveControl(message) {
    if (!message || message.generation !== this.generation()) return;
    if (message.type === 'inventory-start' && this.role === 'guest') {
      this.receiveInventoryStart(message);
      return;
    }
    if (message.type === 'inventory-items' && this.role === 'guest') {
      this.receiveInventoryItems(message);
      return;
    }
    if (message.type === 'inventory-end' && this.role === 'guest') {
      await this.receiveInventoryEnd(message);
      return;
    }
    if (message.type === 'inventory-refresh' && this.role === 'host') {
      this.refreshInventory();
      return;
    }
    if (message.type === 'chunk-start' && this.role === 'host') {
      await this.receiveChunkStart(message);
      return;
    }
    if (message.type === 'take-manifest' && this.role === 'host') {
      await this.receiveManifest(message);
      return;
    }
    if (message.type === 'chunk-ack' && this.role === 'guest') {
      this.receiveAck(message, 'chunk-ack');
      return;
    }
    if (message.type === 'manifest-ack' && this.role === 'guest') {
      this.receiveAck(message, 'manifest-ack');
      return;
    }
    throw new Error('This recovery message is not allowed.');
  }

  receiveInventoryStart(message) {
    if (!UUID_PATTERN.test(message.requestId || '') ||
        !Number.isSafeInteger(message.count) || message.count < 0 ||
        message.count > MAX_INVENTORY_ITEMS) {
      throw new Error('The host recovery inventory start information is invalid.');
    }
    window.clearTimeout(this.inventoryTimer);
    this.inventoryReady = false;
    this.receivedInventory = { requestId: message.requestId, count: message.count, items: [] };
    this.inventoryTimer = window.setTimeout(() => {
      this.receivedInventory = null;
      this.onStatus('The host recovery ledger comparison timed out. Please retry.');
    }, ACK_TIMEOUT_MS);
  }

  receiveInventoryItems(message) {
    const pending = this.receivedInventory;
    if (!pending || message.requestId !== pending.requestId ||
        !Array.isArray(message.items) || message.items.length > INVENTORY_BATCH_ITEMS ||
        message.items.some((item) => !validInventoryItem(item)) ||
        pending.items.length + message.items.length > pending.count) {
      throw new Error('The host recovery inventory batch is invalid.');
    }
    pending.items.push(...message.items);
  }

  async receiveInventoryEnd(message) {
    const pending = this.receivedInventory;
    if (!pending || message.requestId !== pending.requestId ||
        message.count !== pending.count || pending.items.length !== pending.count) {
      throw new Error('The host recovery inventory is incomplete.');
    }
    if (!this.reconcileTransferInventory) throw new Error('Unable to reconcile the recovery inventory.');
    await this.reconcileTransferInventory(this.generation(), pending.items);
    window.clearTimeout(this.inventoryTimer);
    this.inventoryTimer = null;
    this.receivedInventory = null;
    this.inventoryReady = true;
    this.onStatus('Reconciled the host recovery ledger. Any unsaved chunks will be sent again.');
    this.wake();
  }

  generation() {
    return this.getGeneration?.() || null;
  }

  async receiveChunkStart(message) {
    this.currentChunk = null;
    if (!validChunkMetadata(message)) {
      this.sendAck('chunk-ack', message, false, 'The chunk information is invalid.');
      return;
    }
    this.currentChunk = {
      metadata: message,
      parts: [],
      receivedBytes: 0
    };
  }

  async receiveChunkBytes(bytes) {
    const pending = this.currentChunk;
    if (!pending) throw new Error('No matching chunk information was found.');
    if (bytes.byteLength > MESSAGE_BYTES) {
      this.currentChunk = null;
      this.sendAck('chunk-ack', pending.metadata, false, 'The chunk part size exceeds the limit.');
      return;
    }
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > pending.metadata.totalBytes) {
      this.currentChunk = null;
      this.sendAck('chunk-ack', pending.metadata, false, 'The received chunk exceeds the size limit.');
      return;
    }
    pending.parts.push(bytes);
    if (pending.receivedBytes !== pending.metadata.totalBytes) return;
    this.currentChunk = null;
    const fullBytes = new Uint8Array(pending.receivedBytes);
    let offset = 0;
    for (const part of pending.parts) {
      fullBytes.set(part, offset);
      offset += part.byteLength;
    }
    const actualHash = await sha256Hex(fullBytes);
    if (actualHash !== pending.metadata.sha256 ||
        !validWavChunk(fullBytes, pending.metadata.frames)) {
      this.sendAck('chunk-ack', pending.metadata, false, 'The chunk hash or WAV format does not match.');
      return;
    }
    try {
      await this.storeChunk(pending.metadata, new Blob([fullBytes], { type: 'audio/wav' }), actualHash);
      this.sendAck('chunk-ack', pending.metadata, true);
    } catch (error) {
      this.sendAck('chunk-ack', pending.metadata, false, error.message);
    }
  }

  async receiveManifest(message) {
    if (!validManifest(message)) {
      this.sendAck('manifest-ack', message, false, 'The take manifest is invalid.');
      return;
    }
    try {
      await this.storeManifest(message);
      this.sendAck('manifest-ack', message, true);
    } catch (error) {
      this.sendAck('manifest-ack', message, false, error.message);
    }
  }

  sendAck(type, message, accepted, errorMessage = '') {
    try {
      this.sendControl({
        type,
        generation: this.generation(),
        takeId: message.takeId,
        sequence: message.sequence,
        sha256: message.sha256,
        accepted,
        message: errorMessage
      });
    } catch (error) {
      this.onStatus(`Unable to send the recovery acknowledgment: ${error.message}`, true);
    }
  }

  receiveAck(message, type) {
    const id = type === 'chunk-ack'
      ? transferId(message.takeId, message.sequence)
      : `manifest:${message.takeId}`;
    const pending = this.pendingAcks.get(id);
    if (!pending || pending.type !== type ||
        (type === 'chunk-ack' && pending.sha256 !== message.sha256) ||
        typeof message.accepted !== 'boolean') return;
    window.clearTimeout(pending.timer);
    this.pendingAcks.delete(id);
    pending.resolve(message);
  }

  close() {
    this.detachChannel();
  }
}
