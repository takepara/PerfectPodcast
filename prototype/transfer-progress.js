export function summarizeTransferChunks(chunks) {
  return chunks.reduce((summary, chunk) => {
    if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 ||
        !Number.isSafeInteger(chunk.frames) || chunk.frames < 0 ||
        typeof chunk.hostStored !== 'boolean') {
      throw new Error('Invalid chunk information for calculating transfer progress.');
    }
    summary.bytes += chunk.bytes;
    summary.frames += chunk.frames;
    if (chunk.hostStored) {
      summary.hostStoredBytes += chunk.bytes;
      summary.hostStoredFrames += chunk.frames;
    } else {
      summary.pendingBytes += chunk.bytes;
      summary.pendingFrames += chunk.frames;
    }
    return summary;
  }, {
    bytes: 0,
    frames: 0,
    hostStoredBytes: 0,
    hostStoredFrames: 0,
    pendingBytes: 0,
    pendingFrames: 0
  });
}

export function splitTransferBacklog(pendingBytes, activeSend) {
  if (!Number.isSafeInteger(pendingBytes) || pendingBytes < 0 ||
      !activeSend || !['idle', 'sending', 'awaiting-ack'].includes(activeSend.state) ||
      !Number.isSafeInteger(activeSend.bytes) || activeSend.bytes < 0) {
    throw new Error('The transfer queue status is invalid.');
  }
  const activeBytes = activeSend.state === 'idle'
    ? 0
    : Math.min(pendingBytes, activeSend.bytes);
  return {
    unsubmittedBytes: pendingBytes - activeBytes,
    sendingBytes: activeSend.state === 'sending' ? activeBytes : 0,
    awaitingAckBytes: activeSend.state === 'awaiting-ack' ? activeBytes : 0
  };
}
