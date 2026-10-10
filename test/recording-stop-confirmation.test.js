import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeRecordingMetadata } from '../prototype/recording-ledger.js';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const stopSource = source.slice(source.indexOf('async function stopRecording('), source.indexOf('\nfunction audioContextTimeAtPerformanceTime'));

async function stopScenario({ acknowledge = true, failCompletion = false } = {}) {
  const take = { id: 'take', frames: 48000, chunks: 1, bytes: 144044, status: 'recording', transferGeneration: 'generation' };
  const notices = [], saved = [];
  let timeout;
  const port = { onmessage() {}, postMessage() {
    queueMicrotask(() => acknowledge
      ? port.onmessage({ data: { type: 'stopped', frames: 48000, firstSampleContextTime: 0, endSampleContextTime: 1 } })
      : timeout());
  } };
  const context = vm.createContext({
    preparedRecordingEvent: null, recording: true, finalizing: false, activeTake: take,
    performance: { now: () => 2000 }, Date, TARGET_RATE: 48000, MAX_SESSION_FRAMES: 345600000,
    appendNetworkEvent() {}, captureOnAir: true, captureStartPending: false,
    updateCaptureStatusBadge() {}, stopWaveformRendering() {}, updateRecordButtonAvailability() {},
    scheduledRecordingStartAt: null, scheduledRecordingWallStartAt: null, updateRecordingPreparation() {},
    roomCall: { endRecordingWaveform() {}, setHostRecordingState() {}, notifyTakeFinalized(value) { notices.push(value); } },
    window: { clearInterval() {}, clearTimeout() {}, setTimeout(fn) { timeout = fn; return 1; } },
    elapsedTimer: null, takeRefreshTimer: null, recordButton: {}, stopButton: {}, setStatus() {}, recorderNode: { port },
    commitError: null, commitChain: Promise.resolve(), stopDiagnostics: async () => {}, mediaStream: null,
    database: { transaction() { return { objectStore() { return {
      get() { return { result: take, addEventListener(_event, fn) { fn(); } }; },
      put(value) { saved.push(value); }
    }; }, abort() {} }; } },
    transactionComplete: async () => { if (failCompletion) throw new Error('completion write failed'); },
    mergeRecordingMetadata,
    $: () => ({ classList: { remove() {} } }), formatDuration: String, takeFrameLimit: 48000,
    errorText: {}, renderTakes: async () => {}, loadAll: async () => [take], activeSession: { id: 'session' },
    sessionLimitReached: false, updateSessionSavedSize: async () => {}, refreshSessionList: async () => {}, setMessage() {}
  });
  vm.runInContext(stopSource, context);
  return { success: await context.stopRecording(), saved, notices };
}

test('stop ACK and completion save confirm normal finalization', async () => {
  const result = await stopScenario();
  assert.equal(result.success, true);
  assert.equal(result.saved[0].status, 'stopped');
  assert.equal(result.notices[0].tailUnknown, false);
});

test('stop timeout cannot certify an unknown tail as normally saved', { todo: 'Phase 2: stop completion contract' }, async () => {
  const result = await stopScenario({ acknowledge: false });
  assert.equal(result.success, false);
  assert.equal(result.saved[0].status, 'recovered');
  assert.equal(result.saved[0].tailUnknown, true);
});

test('completion transaction failure cannot publish a normal final manifest', { todo: 'Phase 2: stop completion contract' }, async () => {
  const result = await stopScenario({ failCompletion: true });
  assert.equal(result.success, false);
  assert.equal(result.notices.length, 0);
});
