import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAlignment, validTimingPoints, writeAlignedPcm24Wav } from '../prototype/drift-correction.js';
import { createPcm24Wav } from '../prototype/wav-export.js';

function fixture(ppm = 0, seconds = 120) {
  const startPlan = { eventId: 'event', sequence: 1, localTargetPerfMs: 1000 };
  const reference = { frames: seconds * 48000, startPlan, startObservation: {}, timingPoints: [], clockSamples: [] };
  const take = { ...reference, remote: true, timingPoints: [] };
  for (let second = 0; second <= seconds; second += 30) {
    const frame = second * 48000;
    reference.timingPoints.push({ frame, contextTime: second + 1, localPerfMs: 1000 + second * 1000, uncertaintyMs: 0.1 });
    take.timingPoints.push({ frame, contextTime: second + 2, localPerfMs: 5000 + second * 1000 * (1 + ppm / 1e6), uncertaintyMs: 0.1 });
    reference.clockSamples.push({ hostPerfMs: 1000 + second * 1000, guestPerfMs: 5000 + second * 1000, roundTripMs: 1 });
  }
  return { take, reference };
}

test('estimates known ±100 ppm drift over two hours without allocating long audio', () => {
  for (const ppm of [-100, 0, 100]) {
    const { take, reference } = fixture(ppm, 7200);
    const result = assessAlignment(take, reference);
    assert.equal(result.available, true, result.reason);
    assert.ok(Math.abs(result.driftPpm - ppm) < 0.001);
    assert.ok(Math.abs(result.leadingFrames) < 0.001);
  }
});

test('host WAV is an unchanged reference even when its timing measurements are missing', () => {
  const result = assessAlignment({ remote: false, frames: 100 }, null);
  assert.equal(result.reference, true);
  assert.equal(result.available, false);
});

test('equal host and guest audio drift cancels and only relative drift is corrected', () => {
  const { take, reference } = fixture(100, 7200);
  for (const point of reference.timingPoints) point.localPerfMs = 1000 + point.frame / 48 * 1.0001;
  let result = assessAlignment(take, reference);
  assert.equal(result.available, true, result.reason);
  assert.ok(Math.abs(result.driftPpm) < 0.001);
  for (const point of take.timingPoints) point.localPerfMs = 5000 + point.frame / 48 * 1.0002;
  result = assessAlignment(take, reference);
  assert.equal(result.available, true, result.reason);
  assert.ok(Math.abs(result.driftPpm - ((1.0002 / 1.0001 - 1) * 1e6)) < 0.001);
});

test('early and late guest starts map to host frame zero rather than the planned wall time', () => {
  for (const offset of [-10, 10]) {
    const { take, reference } = fixture();
    for (const point of take.timingPoints) point.localPerfMs += offset;
    const result = assessAlignment(take, reference);
    assert.equal(result.available, true, result.reason);
    assert.ok(Math.abs(result.leadingFrames - offset * 48) < 0.001);
  }
});

test('refuses short, uncertain, interrupted, and unstable timing rather than guessing', () => {
  for (const mutate of [
    (take) => { take.timingPoints = take.timingPoints.slice(0, 2); },
    (take) => { take.timingDiscontinuous = true; },
    (take) => { take.timingPoints[2].localPerfMs += 20; },
    (take) => { take.timingPoints[2].contextTime += 0.1; },
    (_take, reference) => { reference.clockSamples.forEach((point) => { point.roundTripMs = 50; }); }
  ]) {
    const { take, reference } = fixture();
    mutate(take, reference);
    assert.equal(assessAlignment(take, reference).available, false);
  }
  assert.equal(validTimingPoints([{ frame: 0, localPerfMs: NaN }]), false);
});

test('coverage diagnostics distinguish host and guest missing first points and unmeasured tails', () => {
  const hostMissing = fixture();
  hostMissing.reference.timingPoints.shift();
  assert.match(assessAlignment(hostMissing.take, hostMissing.reference).reason,
    /Host timing: First timing point is missing.*first frame=1440000/);
  const guestMissing = fixture();
  guestMissing.take.timingPoints.shift();
  assert.match(assessAlignment(guestMissing.take, guestMissing.reference).reason,
    /Guest timing: First timing point is missing/);
  const tail = fixture();
  tail.take.timingPoints = tail.take.timingPoints.slice(0, 3);
  assert.match(assessAlignment(tail.take, tail.reference).reason,
    /Guest timing: Recording tail is not measured.*unmeasured tail=60.0 s/);
});

test('an early guest is trimmed in aligned export while its source WAV stays intact', async () => {
  const input = new Float32Array(1000).fill(0.25);
  const wav = createPcm24Wav(input);
  const chunks = [{ sequence: 0, startFrame: 0, frames: 1000, wav, byteLength: wav.size }];
  const parts = [];
  await writeAlignedPcm24Wav({ frames: 1000 }, chunks, { async write(bytes) { parts.push(bytes); } },
    { available: true, leadingFrames: -480, framesPerInputFrame: 1, outputFrames: 520 });
  assert.equal(new Blob(parts).size, 44 + 520 * 3);
  assert.equal(wav.size, 44 + 1000 * 3);
});

test('windowed sinc export preserves tone and chunk boundaries while padding the common origin', async () => {
  const input = new Float32Array(96000);
  for (let frame = 0; frame < input.length; frame += 1) input[frame] = 0.4 * Math.sin(2 * Math.PI * 1000 * frame / 48000);
  const chunks = [input.slice(0, 48000), input.slice(48000)].map((samples, sequence) => {
    const wav = createPcm24Wav(samples);
    return { sequence, startFrame: sequence * 48000, frames: samples.length, wav, byteLength: wav.size };
  });
  const parts = [];
  const ratio = 1.0001;
  const alignment = { available: true, leadingFrames: 960, framesPerInputFrame: ratio,
    outputFrames: Math.ceil(960 + input.length * ratio) };
  await writeAlignedPcm24Wav({ frames: input.length }, chunks, { async write(bytes) { parts.push(bytes); } }, alignment);
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 48000);
  assert.equal(new DataView(bytes.buffer).getUint16(34, true), 24);
  assert.equal(bytes.length, 44 + alignment.outputFrames * 3);
  assert.ok(bytes.slice(44, 44 + 960 * 3).every((value) => value === 0));
  let error = 0;
  let count = 0;
  for (let frame = 1000; frame < alignment.outputFrames - 100; frame += 1) {
    const offset = 44 + frame * 3;
    let value = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    const expected = 0.4 * Math.sin(2 * Math.PI * 1000 * ((frame - 960) / ratio) / 48000);
    error += (value / 8388608 - expected) ** 2;
    count += 1;
  }
  assert.ok(Math.sqrt(error / count) < 0.0001);
});
