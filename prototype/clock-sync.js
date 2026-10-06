export function calculateClockSample(hostSentAt, guestReceivedAt, guestSentAt, hostReceivedAt) {
  const values = [hostSentAt, guestReceivedAt, guestSentAt, hostReceivedAt];
  if (!values.every(Number.isFinite) || hostReceivedAt < hostSentAt || guestSentAt < guestReceivedAt) {
    throw new RangeError('時刻同期サンプルが不正です。');
  }
  const roundTripMs = (hostReceivedAt - hostSentAt) - (guestSentAt - guestReceivedAt);
  if (roundTripMs < 0) throw new RangeError('時刻同期の往復時間が不正です。');
  const offsetMs = ((guestReceivedAt - hostSentAt) + (guestSentAt - hostReceivedAt)) / 2;
  return { offsetMs, roundTripMs };
}

export function selectClockSample(samples, minimumSamples = 3) {
  if (!Array.isArray(samples) || samples.length < minimumSamples) {
    throw new Error('有効な時刻同期応答が不足しています。');
  }
  return samples.reduce((best, sample) =>
    sample.roundTripMs < best.roundTripMs ? sample : best
  );
}
