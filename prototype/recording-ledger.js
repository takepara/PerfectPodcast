function mergePoints(stored = [], live = [], key) {
  const points = new Map(stored.map((point) => [point[key], point]));
  for (const point of live) points.set(point[key], point);
  return [...points.values()].sort((left, right) => left[key] - right[key]);
}

export function mergeRecordingMetadata(stored, live) {
  if (!stored || !live || stored.id !== live.id) throw new Error('Recording ledger IDs do not match.');
  return {
    ...stored,
    timingPoints: mergePoints(stored.timingPoints, live.timingPoints, 'frame'),
    clockSamples: mergePoints(stored.clockSamples, live.clockSamples, 'hostPerfMs'),
    timingDiscontinuous: Boolean(stored.timingDiscontinuous || live.timingDiscontinuous),
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
