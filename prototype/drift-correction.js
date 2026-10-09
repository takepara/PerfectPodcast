import { createPcm24Wav, makeWavHeader, writePcm24Wav } from './wav-export.js';

const RATE = 48_000;
export const MAX_TIMING_POINTS = 250;

export function validTimingPoints(points) {
  return Array.isArray(points) && points.length <= MAX_TIMING_POINTS && points.every((point, index) =>
    point && Number.isSafeInteger(point.frame) && point.frame >= 0 && point.frame <= RATE * 7200 &&
    Number.isFinite(point.localPerfMs) && point.localPerfMs >= 0 &&
    Number.isFinite(point.contextTime) && point.contextTime >= 0 &&
    Number.isFinite(point.uncertaintyMs) && point.uncertaintyMs >= 0 && point.uncertaintyMs <= 1000 &&
    (index === 0 || point.frame > points[index - 1].frame &&
      point.localPerfMs > points[index - 1].localPerfMs && point.contextTime > points[index - 1].contextTime));
}

export function validClockSamples(samples) {
  return Array.isArray(samples) && samples.length <= MAX_TIMING_POINTS && samples.every((sample, index) =>
    sample && Number.isFinite(sample.hostPerfMs) && sample.hostPerfMs >= 0 &&
    Number.isFinite(sample.guestPerfMs) && sample.guestPerfMs >= 0 &&
    Number.isFinite(sample.roundTripMs) && sample.roundTripMs >= 0 && sample.roundTripMs <= 1000 &&
    (index === 0 || sample.hostPerfMs > samples[index - 1].hostPerfMs));
}

function fit(points, xKey, yKey, minimumSpan, maximumGap) {
  if (points.length < 4) throw new Error('At least four timing measurements are required.');
  const first = points[0];
  const last = points.at(-1);
  if (last[xKey] - first[xKey] < minimumSpan) throw new Error('At least 60 seconds of timing measurements are required.');
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][xKey] - points[index - 1][xKey] > maximumGap) {
      throw new Error('Timing measurements contain a gap; automatic correction is unavailable.');
    }
  }
  const xMean = points.reduce((sum, point) => sum + point[xKey] - first[xKey], 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point[yKey] - first[yKey], 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const x = point[xKey] - first[xKey] - xMean;
    numerator += x * (point[yKey] - first[yKey] - yMean);
    denominator += x * x;
  }
  const slope = numerator / denominator;
  const intercept = first[yKey] + yMean - slope * (first[xKey] + xMean);
  const errors = points.map((point) => point[yKey] - (intercept + slope * point[xKey]));
  const residualMs = Math.max(...errors.map(Math.abs));
  const rmsMs = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    throw new Error('The timing model could not be calculated.');
  }
  if (residualMs > 2) {
    const worst = errors.findIndex((error) => Math.abs(error) === residualMs);
    throw new Error(`Timing is unstable (max residual=${residualMs.toFixed(2)} ms, RMS=${rmsMs.toFixed(2)} ms, points=${points.length}, worst ${xKey}=${points[worst][xKey]}; limit=2 ms).`);
  }
  return { slope, intercept, residualMs };
}

function audioModel(take, label) {
  try {
    return fitAudioModel(take);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function fitAudioModel(take) {
  const points = take.timingPoints;
  if (take.tailUnknown || take.timingDiscontinuous || !take.startObservation || !validTimingPoints(points)) {
    throw new Error('Missing or discontinuous audio timing; only the original WAV can be exported.');
  }
  if (points.some((point) => point.uncertaintyMs > 2)) throw new Error('Audio clock measurement uncertainty exceeds 2 ms.');
  if (!points.length) throw new Error('No audio timing points were saved.');
  if (points[0].frame !== 0) {
    throw new Error(`First timing point is missing (points=${points.length}, first frame=${points[0].frame}).`);
  }
  const tailSeconds = (take.frames - points.at(-1).frame) / RATE;
  if (tailSeconds > 35) {
    throw new Error(`Recording tail is not measured (points=${points.length}, unmeasured tail=${tailSeconds.toFixed(1)} s; limit=35 s).`);
  }
  const model = fit(points, 'frame', 'localPerfMs', RATE * 60, RATE * 45);
  if (Math.abs(model.slope * RATE / 1000 - 1) > 0.001) throw new Error('Audio clock rate exceeds the supported ±1000 ppm range.');
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (Math.abs((point.contextTime - previous.contextTime) * RATE - (point.frame - previous.frame)) > 2) {
      throw new Error('The audio clock contains an input gap or discontinuity.');
    }
  }
  return model;
}

export function assessAlignment(take, reference) {
  if (!take.remote) return { available: false, reference: true, reason: 'Host audio is the unchanged alignment reference.' };
  try {
    if (!reference || reference.remote || !take.startPlan ||
        take.startPlan.eventId !== reference.startPlan?.eventId ||
        take.startPlan.sequence !== reference.startPlan.sequence) {
      throw new Error('A matching host recording is required.');
    }
    const host = audioModel(reference, 'Host timing');
    const local = audioModel(take, 'Guest timing');
    let model = local;
    let clockErrorMs = 0;
    if (take.remote) {
      const samples = reference.clockSamples;
      if (!validClockSamples(samples)) throw new Error('The inter-device clock measurements are invalid.');
      const usable = samples.filter((sample) => sample.roundTripMs <= 4);
      const clocks = fit(usable, 'guestPerfMs', 'hostPerfMs', 60_000, 75_000);
      if (Math.abs(clocks.slope - 1) > 0.001) throw new Error('The inter-device clock rate exceeds the supported range.');
      const start = local.intercept;
      const end = start + local.slope * take.frames;
      if (start - usable[0].guestPerfMs > 35_000 || end - usable.at(-1).guestPerfMs > 35_000 ||
          usable[0].guestPerfMs - start > 35_000) {
        throw new Error('Clock synchronization measurements do not cover the recording.');
      }
      clockErrorMs = clocks.residualMs + Math.max(...usable.map((sample) => sample.roundTripMs / 2));
      model = { slope: clocks.slope * local.slope, intercept: clocks.intercept + clocks.slope * local.intercept,
        residualMs: local.residualMs };
    }
    const uncertaintyMs = host.residualMs + model.residualMs + clockErrorMs +
      Math.max(...take.timingPoints.map((point) => point.uncertaintyMs));
    if (uncertaintyMs > 5) throw new Error('Estimated timing uncertainty exceeds 5 ms.');
    // Invert the host audio-clock model: output frame zero is the host's recorded frame zero.
    const originMs = host.intercept;
    const leadingFrames = (model.intercept - originMs) / host.slope;
    if (Math.abs(leadingFrames) > RATE * 5) throw new Error('The recording start lies outside the supported alignment window.');
    const framesPerInputFrame = model.slope / host.slope;
    if (Math.abs(framesPerInputFrame - 1) > 0.002) throw new Error('Relative audio clock drift exceeds the supported ±2000 ppm range.');
    const outputFrames = Math.ceil(leadingFrames + take.frames * framesPerInputFrame);
    makeWavHeader(outputFrames);
    return { available: true, leadingFrames, framesPerInputFrame, outputFrames,
      driftPpm: (framesPerInputFrame - 1) * 1e6, uncertaintyMs, originMs };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

function decodePcm24(bytes, index) {
  const offset = index * 3;
  const value = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
  return (value & 0x800000 ? value - 0x1000000 : value) / 8388608;
}

export async function writeAlignedPcm24Wav(take, chunks, writable, alignment) {
  if (!alignment?.available || !Number.isFinite(alignment.leadingFrames) || Math.abs(alignment.leadingFrames) > RATE * 5 ||
      !Number.isFinite(alignment.framesPerInputFrame) || Math.abs(alignment.framesPerInputFrame - 1) > 0.002 ||
      alignment.outputFrames !== Math.ceil(alignment.leadingFrames + take.frames * alignment.framesPerInputFrame)) {
    throw new Error('A valid alignment assessment is required before corrected export.');
  }
  // Validate the original ledger and WAV headers before emitting any corrected bytes.
  await writePcm24Wav(take, chunks, { async write() {} });
  await writable.write(makeWavHeader(alignment.outputFrames));
  const cache = new Map();
  const radius = 32;
  const cutoff = 0.95 * Math.min(1, alignment.framesPerInputFrame);
  let chunkIndex = 0;
  const sample = (frame) => {
    if (frame < 0 || frame >= take.frames) return 0;
    while (chunkIndex + 1 < chunks.length && frame >= chunks[chunkIndex + 1].startFrame) chunkIndex += 1;
    while (chunkIndex > 0 && frame < chunks[chunkIndex].startFrame) chunkIndex -= 1;
    if (!cache.has(chunkIndex)) throw new Error('The resampling input window is incomplete.');
    return decodePcm24(cache.get(chunkIndex), frame - chunks[chunkIndex].startFrame);
  };
  for (let start = 0; start < alignment.outputFrames; start += RATE) {
    const output = new Float32Array(Math.min(RATE, alignment.outputFrames - start));
    const low = Math.floor((start - alignment.leadingFrames) / alignment.framesPerInputFrame) - radius;
    const high = Math.ceil((start + output.length - alignment.leadingFrames) / alignment.framesPerInputFrame) + radius;
    for (let key = 0; key < chunks.length; key += 1) {
      const chunk = chunks[key];
      if (chunk.startFrame + chunk.frames > low && chunk.startFrame <= high) {
        if (!cache.has(key)) cache.set(key, new Uint8Array(await chunk.wav.slice(44).arrayBuffer()));
      } else cache.delete(key);
    }
    for (let index = 0; index < output.length; index += 1) {
      const position = (start + index - alignment.leadingFrames) / alignment.framesPerInputFrame;
      if (position < 0 || position >= take.frames) continue;
      const base = Math.floor(position);
      let value = 0;
      let weightSum = 0;
      for (let tap = base - radius + 1; tap <= base + radius; tap += 1) {
        const distance = position - tap;
        if (Math.abs(distance) >= radius) continue;
        const x = Math.PI * distance * cutoff;
        const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
        const weight = cutoff * sinc * window;
        value += weight * sample(tap);
        weightSum += weight;
      }
      output[index] = value / weightSum;
    }
    await writable.write(await createPcm24Wav(output).slice(44).arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
