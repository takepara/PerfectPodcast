export const MAX_PENDING_COMMITS = 60;

export class CommitQueue {
  constructor(repository, takeId, { now = () => performance.now(), onMetrics = () => {} } = {}) {
    this.repository = repository;
    this.takeId = takeId;
    this.now = now;
    this.onMetrics = onMetrics;
    this.pending = new Set();
    this.chain = Promise.resolve();
    this.failure = null;
    this.transactionMs = 0;
    this.maxPendingFrames = 0;
    this.maxPendingBytes = 0;
    this.maxOldestWaitMs = 0;
  }

  get metrics() {
    const items = [...this.pending];
    const pendingFrames = items.reduce((total, item) => total + item.frames, 0);
    const pendingBytes = items.reduce((total, item) => total + item.bytes, 0);
    const oldestWaitMs = items.length ? Math.max(0, this.now() - items[0].queuedAt) : 0;
    this.maxPendingFrames = Math.max(this.maxPendingFrames, pendingFrames);
    this.maxPendingBytes = Math.max(this.maxPendingBytes, pendingBytes);
    this.maxOldestWaitMs = Math.max(this.maxOldestWaitMs, oldestWaitMs);
    return Object.freeze({ takeId: this.takeId, pendingChunks: items.length, pendingFrames,
      pendingBytes, oldestWaitMs, transactionMs: this.transactionMs,
      maxPendingFrames: this.maxPendingFrames, maxPendingBytes: this.maxPendingBytes,
      maxOldestWaitMs: this.maxOldestWaitMs });
  }

  emit() {
    const metrics = this.metrics;
    try { this.onMetrics(metrics); } catch { /* Metrics must not affect persistence. */ }
  }

  enqueue(chunk) {
    if (chunk.takeId !== this.takeId) throw new Error('Recording queue take ID does not match.');
    if (!canQueueRecordingCommit(this.pending.size, chunk.final === true)) {
      throw new Error('The IndexedDB save queue has reached 60 chunks. Recording stopped to prevent data loss.');
    }
    const { takeId, sequence, startFrame, frames, byteLength, wav, transferGeneration, hostStored, final, committedAt } = chunk;
    const input = structuredClone({ takeId, sequence, startFrame, frames, byteLength, wav, transferGeneration, hostStored, final, committedAt });
    chunk = null;
    const item = { frames: input.frames, bytes: input.byteLength, queuedAt: this.now() };
    this.pending.add(item);
    this.emit();
    const task = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      this.emit();
      try {
        const result = await this.repository.commitChunk(input);
        this.transactionMs = result.transactionMs;
        return result;
      } catch (error) {
        this.transactionMs = error.transactionMs ?? 0;
        this.failure = error;
        throw error;
      }
    }).finally(() => {
      this.emit();
      this.pending.delete(item);
      this.emit();
    });
    // Keep ordering alive while preserving the first failure for drain and later work.
    this.chain = task.catch(() => {});
    return task;
  }

  patch(patch) {
    const input = structuredClone(patch);
    const task = this.chain.then(() => this.repository.patchTake(this.takeId, input));
    this.chain = task.catch((error) => { this.failure ||= error; });
    return task;
  }

  async drain() {
    await this.chain;
    if (this.failure) throw this.failure;
  }
}

export async function publishRecordingCommit(result, { update = () => {}, notify = () => {}, onError = () => {} } = {}) {
  const failures = [];
  for (const [stage, effect] of [['display', update], ['notification', notify]]) {
    try { await effect(result); }
    catch (error) {
      failures.push({ stage, error });
      try { onError(stage, error); } catch { /* Error reporting is not a storage operation. */ }
    }
  }
  return failures;
}

export function canQueueRecordingCommit(pendingCommits, isFinal) {
  if (!Number.isSafeInteger(pendingCommits) || pendingCommits < 0 || typeof isFinal !== 'boolean') {
    throw new TypeError('The number of pending recording chunks is invalid.');
  }
  return isFinal || pendingCommits < MAX_PENDING_COMMITS;
}
