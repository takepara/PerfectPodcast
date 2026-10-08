export function calculateClockSample(hostSentAt, guestReceivedAt, guestSentAt, hostReceivedAt) {
  const values = [hostSentAt, guestReceivedAt, guestSentAt, hostReceivedAt];
  if (!values.every(Number.isFinite) || hostReceivedAt < hostSentAt || guestSentAt < guestReceivedAt) {
    throw new RangeError('The clock synchronization sample is invalid.');
  }
  const roundTripMs = (hostReceivedAt - hostSentAt) - (guestSentAt - guestReceivedAt);
  if (roundTripMs < 0) throw new RangeError('The clock synchronization round-trip time is invalid.');
  const offsetMs = ((guestReceivedAt - hostSentAt) + (guestSentAt - hostReceivedAt)) / 2;
  return { offsetMs, roundTripMs };
}

export function selectClockSample(samples, minimumSamples = 3) {
  if (!Array.isArray(samples) || samples.length < minimumSamples) {
    throw new Error('There are not enough valid clock synchronization responses.');
  }
  return samples.reduce((best, sample) =>
    sample.roundTripMs < best.roundTripMs ? sample : best
  );
}
