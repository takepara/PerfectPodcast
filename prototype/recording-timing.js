const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function validWallTime(value) {
  return value === null || Number.isFinite(value) && value > 0 && value <= 8.64e15;
}

export function validStartPlan(plan) {
  return plan === null || Boolean(plan && UUID_PATTERN.test(plan.eventId || '') &&
    Number.isSafeInteger(plan.sequence) && plan.sequence > 0 &&
    Number.isFinite(plan.localTargetPerfMs) && plan.localTargetPerfMs >= 0 &&
    validWallTime(plan.displayStartedAt) && plan.displayStartedAt !== null);
}

export function validStartObservation(observation) {
  return observation === null || Boolean(observation && observation.frame === 0 &&
    Number.isFinite(observation.localPerfMs) && observation.localPerfMs >= 0 &&
    Number.isFinite(observation.contextTime) && observation.contextTime >= 0);
}

export function sameStartPlan(left, right) {
  if (!left || !right) return (left ?? null) === (right ?? null);
  return left.eventId === right.eventId && left.sequence === right.sequence &&
    left.localTargetPerfMs === right.localTargetPerfMs && left.displayStartedAt === right.displayStartedAt;
}

export function createStartPlan(schedule, nowPerfMs) {
  if (!schedule || !Number.isFinite(schedule.startAt) || schedule.startAt < nowPerfMs + 250 ||
      !validWallTime(schedule.hostStartedAt) || schedule.hostStartedAt === null ||
      !schedule.event) {
    throw new Error('The synchronized recording start plan is missing, invalid, or too late.');
  }
  const plan = {
    eventId: schedule.event.eventId,
    sequence: schedule.event.sequence,
    localTargetPerfMs: schedule.startAt,
    displayStartedAt: schedule.hostStartedAt
  };
  if (!validStartPlan(plan)) throw new Error('The synchronized recording start plan is invalid.');
  return Object.freeze(plan);
}
