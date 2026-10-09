import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createStartPlan } from '../prototype/recording-timing.js';
import { RecordingTransfer } from '../prototype/recording-transfer.js';
import { createPcm24Wav } from '../prototype/wav-export.js';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const activation = source.slice(source.indexOf('async function activatePreparedTake('), source.indexOf('\nasync function stopDiagnostics'));
const event = { eventId: '123e4567-e89b-42d3-a456-426614174000', sequence: 1 };

function setup() {
  const saved = [];
  const messages = [];
  const context = vm.createContext({
    createStartPlan, performance: { now: () => 1000 },
    activeTake: { id: 'take', startedAt: null },
    preparedRecordingEvent: event, cancelRecordingStart: false,
    audioContext: {}, roomCall: null, recording: false, captureOnAir: false, takeFrameLimit: 100,
    window: { setTimeout, clearTimeout, setInterval: () => 1 },
    persistTake: async (take) => saved.push(structuredClone(take)),
    audioContextTimeAtPerformanceTime: (time) => time / 1000,
    appendNetworkEvent() {}, checkRecordingTrackMute: null,
    takeStartedAt: 0, elapsedTimer: null, updateTimer() {},
    recordButton: {}, stopButton: {}, setStatus() {}, updateRecordingPreparation() {},
    $: () => ({ classList: { toggle() {} } }),
    recorderNode: { port: {
      onmessage: null,
      postMessage(message) {
        assert.equal(saved.length, 1, 'persist the plan before arming the processor');
        messages.push(message);
        this.onmessage({ data: { type: 'armed', event } });
      }
    } }
  });
  vm.runInContext(activation, context);
  return { context, saved, messages };
}

test('prepared recording persists and arms the canonical schedule instead of starting immediately', async () => {
  const { context, saved, messages } = setup();
  await context.activatePreparedTake({ startAt: 1500, hostStartedAt: 1791519200000, event });
  assert.equal(saved[0].startedAt, 1791519200000);
  assert.equal(saved[0].startPlan.localTargetPerfMs, 1500);
  assert.equal(saved[0].startObservation, null);
  assert.equal(saved[0].captureStatus, 'armed');
  assert.equal(messages[0].startAt, 1.5);
  assert.equal(messages[0].eventId, event.eventId);
  assert.equal(context.recording, true);
});

test('missing and late synchronized schedules fail before persisting or arming', async () => {
  for (const schedule of [{ event }, { startAt: 1100, hostStartedAt: 1791519200000, event }]) {
    const { context, saved, messages } = setup();
    await assert.rejects(context.activatePreparedTake(schedule), /start plan/);
    assert.equal(saved.length, 0);
    assert.equal(messages.length, 0);
  }
});

test('scheduled processor audio reaches host storage and manifest ACK with its independent observation', async () => {
  const { context: activationContext, saved, messages } = setup();
  await activationContext.activatePreparedTake({ startAt: 1500, hostStartedAt: 1791519200000, event });
  let Processor;
  const processorContext = { currentTime: 1, sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); } }; } },
    registerProcessor: (_name, processor) => { Processor = processor; }
  };
  vm.runInNewContext(readFileSync(new URL('../prototype/recorder-worklet.js', import.meta.url), 'utf8'), processorContext);
  const processor = new Processor();
  processor.port.onmessage({ data: messages[0] });
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  assert.equal(processor.totalFrames, 0);
  processorContext.currentTime = 1.5;
  processor.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  const observed = processor.port.messages.find((message) => message.type === 'started');
  const audio = processor.port.messages.find((message) => message.type === 'audio');
  assert.equal(observed.contextTime, 1.5);
  const take = { ...saved[0], id: event.eventId, number: 1, participant: 'Guest',
    transferGeneration: 'test-generation', status: 'stopped', frames: 100, chunks: 1,
    startObservation: { frame: 0, contextTime: observed.contextTime, localPerfMs: 1500 },
    timingPoints: [{ frame: 0, contextTime: 1.5, localPerfMs: 1500, uncertaintyMs: 1 }],
    timingDiscontinuous: false };
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  let hostSaved = false;
  let chunkConfirmed = false;
  let complete = false;
  const host = new RecordingTransfer({ role: 'host', isAuthorized: () => true,
    getGeneration: () => take.transferGeneration, onStatus() {},
    storeChunk: async (metadata, wav) => {
      assert.equal(metadata.startedAt, saved[0].startedAt);
      assert.equal(metadata.startPlan.eventId, event.eventId);
      assert.equal(wav.size, 344);
      hostSaved = true;
    },
    storeManifest: async (manifest) => {
      assert.equal(hostSaved, true);
      assert.equal(manifest.startObservation.contextTime, 1.5);
      assert.equal(manifest.timingPoints.length, 1);
      assert.equal(manifest.timingPoints[0].frame, 0);
      assert.equal(manifest.timingDiscontinuous, false);
      assert.equal(manifest.startedAt, saved[0].startedAt);
    }
  });
  const guest = new RecordingTransfer({ role: 'guest', isAuthorized: () => true,
    getGeneration: () => take.transferGeneration, onStatus() {}, prepareChunk: async () => {},
    markChunkStored: async () => { assert.equal(hostSaved, true); chunkConfirmed = true; },
    markManifestStored: async () => { complete = true; }
  });
  host.channel = { readyState: 'open', bufferedAmount: 0, removeEventListener() {}, send: (data) => { void guest.receive(data); } };
  guest.channel = { readyState: 'open', bufferedAmount: 0, removeEventListener() {}, send: (data) => {
    host.receiveChain = host.receiveChain.then(() => host.receive(data));
  } };
  try {
    await guest.sendChunkWithRetry({ take, chunk: { sequence: 0, startFrame: 0,
      frames: 100, final: true, wav: createPcm24Wav(audio.samples) } });
    await guest.sendManifestWithRetry(take);
    assert.equal(chunkConfirmed, true);
    assert.equal(complete, true);
  } finally {
    host.close(); guest.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('a stop received before the scheduled Worklet start cannot start recording later', () => {
  let Processor;
  const context = { currentTime: 0, sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_name, processor) => { Processor = processor; }
  };
  vm.runInNewContext(readFileSync(new URL('../prototype/recorder-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'start', startAt: 1, maximumFrames: 100 } });
  processor.port.onmessage({ data: { type: 'stop' } });
  context.currentTime = 2;
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  assert.equal(processor.totalFrames, 0);
});
