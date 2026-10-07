const MAX_PENDING_COMMITS = 60;

export function canQueueRecordingCommit(pendingCommits, isFinal) {
  if (!Number.isSafeInteger(pendingCommits) || pendingCommits < 0 || typeof isFinal !== 'boolean') {
    throw new TypeError('録音チャンクの保存待ち数が不正です。');
  }
  return isFinal || pendingCommits < MAX_PENDING_COMMITS;
}
