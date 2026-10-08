const SAMPLE_INTERVAL_MS = 100;

export function resetWaveformHistory(waveform, startedAt = null, now = performance.now()) {
  if (!waveform || !(waveform.history instanceof Float32Array) || waveform.history.length === 0 ||
      (startedAt !== null && !Number.isFinite(startedAt)) || !Number.isFinite(now)) {
    throw new TypeError('The waveform history initialization data is invalid.');
  }
  const elapsedSamples = startedAt === null
    ? 0
    : Math.min(waveform.history.length, Math.floor(Math.max(0, now - startedAt) / SAMPLE_INTERVAL_MS));
  waveform.history.fill(0);
  waveform.historyCount = elapsedSamples;
  waveform.lastSampleIndex = elapsedSamples - 1;
  waveform.recordingStartedAt = startedAt;
  waveform.startedAt = startedAt ?? now;
  waveform.sampledAt = now;
  waveform.rulerSecond = -1;
}

export function appendAlignedWaveformPeak(waveform, peak, now) {
  if (!waveform || !(waveform.history instanceof Float32Array) ||
      !Number.isFinite(peak) || peak < 0 || !Number.isFinite(now)) {
    throw new TypeError('The waveform sample is invalid.');
  }
  if (waveform.recordingStartedAt === null) return false;

  const sampleIndex = Math.floor((now - waveform.recordingStartedAt) / SAMPLE_INTERVAL_MS) - 1;
  if (sampleIndex < 0 || sampleIndex <= waveform.lastSampleIndex) return false;

  const { history } = waveform;
  if (sampleIndex < history.length) {
    history.fill(0, waveform.lastSampleIndex + 1, sampleIndex);
    history[sampleIndex] = peak;
    waveform.historyCount = Math.max(waveform.historyCount, sampleIndex + 1);
  } else {
    const shift = Math.min(history.length, sampleIndex - waveform.lastSampleIndex);
    history.copyWithin(0, shift);
    history.fill(0, history.length - shift);
    history[history.length - 1] = peak;
    waveform.historyCount = history.length;
  }
  waveform.lastSampleIndex = sampleIndex;
  waveform.sampledAt = now;
  return true;
}
