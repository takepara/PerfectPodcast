function validCounter(value) {
  return Number.isFinite(value) && value >= 0;
}

export function calculateIntervalStats(previous, current, elapsedMs) {
  if (!previous || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { bitrateKbps: null, packetLossPercent: null, concealedSamples: null };
  }

  let bitrateKbps = null;
  if (validCounter(previous.bytesSent) && validCounter(current.bytesSent) &&
      current.bytesSent >= previous.bytesSent) {
    bitrateKbps = (current.bytesSent - previous.bytesSent) * 8 / elapsedMs;
  }

  let packetLossPercent = null;
  if (validCounter(previous.packetsReceived) && validCounter(current.packetsReceived) &&
      Number.isFinite(previous.packetsLost) && Number.isFinite(current.packetsLost) &&
      current.packetsReceived >= previous.packetsReceived &&
      current.packetsLost >= previous.packetsLost) {
    const received = current.packetsReceived - previous.packetsReceived;
    const lost = current.packetsLost - previous.packetsLost;
    if (received + lost > 0) packetLossPercent = lost * 100 / (received + lost);
  }

  let concealedSamples = null;
  if (validCounter(previous.concealedSamples) && validCounter(current.concealedSamples) &&
      current.concealedSamples >= previous.concealedSamples) {
    concealedSamples = current.concealedSamples - previous.concealedSamples;
  }

  return { bitrateKbps, packetLossPercent, concealedSamples };
}
