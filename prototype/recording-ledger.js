export function mergeRecordingMetadata(stored, live) {
  if (!stored || !live || stored.id !== live.id) throw new Error('Recording ledger IDs do not match.');
  return {
    ...stored,
    startObservation: live.startObservation ?? stored.startObservation ?? null,
    captureStatus: live.startObservation || stored.startObservation ? 'started' : stored.captureStatus,
    synchronization: stored.synchronization ?? live.synchronization
  };
}

export function synchronizationForTake(take, takes) {
  if (take.synchronization) return take.synchronization;
  if (!take.startPlan) return null;
  return takes.find((reference) => !reference.remote && reference.sessionId === take.sessionId &&
    reference.startPlan?.eventId === take.startPlan.eventId &&
    reference.startPlan.sequence === take.startPlan.sequence)?.synchronization ?? null;
}
