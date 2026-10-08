export const MAX_SESSION_FRAMES = 2 * 60 * 60 * 48_000;

export function remainingSessionFrames(savedFrames) {
  if (!Number.isSafeInteger(savedFrames) || savedFrames < 0) {
    throw new RangeError('The number of saved frames is invalid.');
  }
  return Math.max(0, MAX_SESSION_FRAMES - savedFrames);
}
