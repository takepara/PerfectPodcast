const MAX_PENDING_COMMITS = 60;

export function canQueueRecordingCommit(pendingCommits, isFinal) {
  if (!Number.isSafeInteger(pendingCommits) || pendingCommits < 0 || typeof isFinal !== 'boolean') {
    throw new TypeError('The number of pending recording chunks is invalid.');
  }
  return isFinal || pendingCommits < MAX_PENDING_COMMITS;
}
