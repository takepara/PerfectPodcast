import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RoomCall } from '../prototype/room-call.js';
import { resetEventLog } from '../prototype/event-log.js';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const changeMicrophoneSource = source.slice(source.indexOf('async function changeMicrophone()'), source.indexOf('async function checkRecordingReadiness()'));
const openSessionSource = source.slice(source.indexOf('async function openSession(session)'), source.indexOf('async function detectDevices'));
const primeRecordingAudioContextSource = source.slice(source.indexOf('function primeRecordingAudioContext()'), source.indexOf('\nfunction startRecording'));
const startRecordingSource = source.slice(source.indexOf('function startRecording('), source.indexOf('\nfunction applyHostRecordingState'));
const samplePreviewMeterSource = source.slice(source.indexOf('function samplePreviewMeter()'), source.indexOf('\nfunction startMeterMonitoring'));
const microphoneMuteSource = source.slice(source.indexOf('function getLocalMicrophoneLabel()'), source.indexOf('\nfunction samplePreviewMeter'));
const waveformStateSource = source.slice(source.indexOf('function setLocalWaveformState('), source.indexOf('\nasync function startLocalPreview'));

function setupSession({ failure = false, recording = false, leaveDuringCapture = false } = {}) {
  const events = [];
  const elements = new Map();
  const stream = {};
  const context = vm.createContext({
    activeSession: null, roomCall: null, recording, starting: false, recordingController: { snapshot: { recording, starting: false } },
    resetEventLog, networkEventCount: 10, networkEventLogStartedAt: 0, performance: { now: () => 100 },
    waveformElapsedSeconds: 0, sessionLimitReached: false, MAX_SESSION_FRAMES: 100,
    setupView: {}, studioView: { hidden: true }, errorText: {},
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { replaceChildren() {}, classList: { remove() {} } });
      return elements.get(id);
    },
    stopWaveformRendering: () => events.push('clear'), setStatus: () => {},
    renderTakes: async () => ({ takes: [], bytes: 0, localFrames: 0 }), loadAll: async () => [], updateRecordButtonAvailability: () => {},
    updateSessionSavedSize: async () => {},
    ensureCaptureStream: async () => {
      events.push('capture');
      if (failure) throw new Error('permission denied');
      if (leaveDuringCapture) { context.activeSession = null; context.studioView.hidden = true; }
      return stream;
    },
    startLocalPreview: (input) => { assert.equal(input, stream); events.push('preview'); },
    releaseCaptureStream: async () => events.push('release'),
    setLocalWaveformState: (state) => events.push(state)
  });
  vm.runInContext(openSessionSource, context);
  return { context, events };
}

test('starts microphone preview on session open without a call or device change', async () => {
  const { context, events } = setupSession();
  await context.openSession({ id: 'session', name: 'Session', participant: 'Participant' });
  assert.deepEqual(events, ['clear', 'capture', 'preview']);
  assert.equal(events.includes('draw'), false);
  assert.equal(context.studioView.hidden, false);
});

test('hides waiting labels while preserving active waveform states', () => {
  const element = { textContent: '', classList: { toggle() {} } };
  const context = vm.createContext({ $: () => element });
  vm.runInContext(waveformStateSource, context);

  context.setLocalWaveformState('Waiting to record');
  assert.equal(element.textContent, '');
  context.setLocalWaveformState('LIVE', true);
  assert.equal(element.textContent, 'LIVE');
});

test('keeps the session open and reports microphone acquisition failures', async () => {
  const { context, events } = setupSession({ failure: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.equal(context.studioView.hidden, false);
  assert.deepEqual(events, ['clear', 'capture', 'Waiting for microphone']);
  assert.match(context.errorText.textContent, /permission denied/);
});

test('does not reacquire capture when opening a session during recording', async () => {
  const { context, events } = setupSession({ recording: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.deepEqual(events, ['clear']);
});

test('releases delayed capture if the user leaves the session before permission resolves', async () => {
  const { context, events } = setupSession({ leaveDuringCapture: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.deepEqual(events, ['clear', 'capture', 'release']);
});

test('updates the input level meter during preview without recording', () => {
  const levels = [];
  let nextFrame;
  const context = vm.createContext({
    previewStream: {},
    previewAnalyserNode: {
      getFloatTimeDomainData(samples) { samples.set([0.1, -0.8, 0.3]); }
    },
    previewSamples: new Float32Array(3),
    previewAudioContext: { state: 'running' },
    recording: false, recordingController: { snapshot: { recording: false } },
    meterFrame: null,
    updateMeter: (peak) => levels.push(peak),
    window: { requestAnimationFrame: (callback) => { nextFrame = callback; return 1; } }
  });
  vm.runInContext(samplePreviewMeterSource, context);
  context.samplePreviewMeter();
  assert.equal(levels.length, 1);
  assert.ok(Math.abs(levels[0] - 0.8) < 1e-6);
  assert.equal(typeof nextFrame, 'function');
});

test('primes the shared engine before asynchronous host checks', async () => {
  const prepared = { context: { state: 'running', sampleRate: 48000 }, resume: Promise.resolve(null) };
  let calls = 0;
  const context = vm.createContext({
    localAudioEngine: { prime() { calls += 1; return prepared; } },
    activeSession: {}, recording: false, appendNetworkEvent() {}
  });
  vm.runInContext(primeRecordingAudioContextSource, context);
  assert.equal(context.primeRecordingAudioContext(), prepared);
  assert.equal(calls, 1);
  assert.equal(await prepared.resume, null);
  assert.ok(startRecordingSource.indexOf('primeRecordingAudioContext()') < startRecordingSource.indexOf('await getHostSession()'));
  assert.ok(startRecordingSource.indexOf('primeRecordingAudioContext()') < startRecordingSource.indexOf('await roomCall.synchronizeClock()'));
});

test('toggles the microphone track and mute button state', () => {
  const track = { readyState: 'live', enabled: true };
  const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const context = vm.createContext({
    mediaStream: { getAudioTracks: () => [track] },
    previewStream: null,
    microphoneMuted: false,
    lastPeak: 0.5,
    $: () => button,
    setMessage: () => {},
    updateMeter: () => {}
  });
  vm.runInContext(microphoneMuteSource, context);

  context.toggleMicrophoneMute();
  assert.equal(track.enabled, false);
  assert.equal(button.textContent, 'UNMUTE');
  assert.equal(button.attributes['aria-pressed'], 'true');

  context.toggleMicrophoneMute();
  assert.equal(track.enabled, true);
  assert.equal(button.textContent, 'MUTE');
  assert.equal(button.attributes['aria-pressed'], 'false');
});

function setup({ blocked = false, connected = false, failure = null } = {}) {
  const events = [];
  const hint = {};
  const oldStream = { marker: 'old', getTracks: () => [{ stop: () => events.push('stop-old') }] };
  const newStream = {
    marker: 'new',
    getTracks: () => [{ stop: () => events.push('stop-new') }],
    getAudioTracks: () => [{ enabled: true }]
  };
  const context = vm.createContext({
    micDevice: { value: 'old' },
    trackMicDevice: { value: 'new', disabled: blocked },
    mediaStream: oldStream,
    microphoneMuted: false,
    switchingMicrophone: false,
    roomCall: connected ? {
      connected: true,
      checkLocalReadiness: async () => events.push('readiness'),
      attachLocalAudio: async (stream) => {
        assert.equal(stream.marker, 'new');
        events.push('replace');
        if (failure === 'replace') throw new Error('replace failed');
      }
    } : null,
    $: () => hint,
    updateRecordButtonAvailability: () => {},
    acquireMicrophoneStream: async (deviceId) => {
      assert.equal(deviceId, 'new');
      events.push('acquire');
      if (failure === 'acquire') throw new Error('permission denied');
      return newStream;
    },
    startLocalPreview: (stream) => {
      assert.equal(stream.marker, 'new');
      events.push('preview');
    }
  });
  vm.runInContext(changeMicrophoneSource, context);
  return { context, events, hint, oldStream, newStream };
}

test('switches local capture and preview before stopping the old microphone', async () => {
  const { context, events, newStream } = setup();
  await context.changeMicrophone();
  assert.equal(context.mediaStream.marker, 'new');
  assert.equal(context.micDevice.value, 'new');
  assert.equal(context.switchingMicrophone, false);
  assert.deepEqual(events, ['acquire', 'preview', 'stop-old']);
});

test('replaces authenticated call audio and rechecks readiness after switching', async () => {
  const { context, events } = setup({ connected: true });
  await context.changeMicrophone();
  assert.deepEqual(events, ['readiness', 'acquire', 'replace', 'preview', 'stop-old', 'readiness']);
});

for (const failure of ['acquire', 'replace']) {
  test(`preserves original microphone when ${failure} fails`, async () => {
    const { context, events, oldStream, hint } = setup({ connected: true, failure });
    await context.changeMicrophone();
    assert.equal(context.mediaStream.marker, 'old');
    assert.equal(context.micDevice.value, 'old');
    assert.equal(context.trackMicDevice.value, 'old');
    assert.equal(context.switchingMicrophone, false);
    assert.equal(events.includes('stop-old'), false);
    assert.equal(events.includes('stop-new'), failure === 'replace');
    assert.match(hint.textContent, /Unable to change microphone/);
  });
}

test('does not acquire or replace a device when the dropdown is disabled', async () => {
  const { context, events, oldStream } = setup({ blocked: true });
  await context.changeMicrophone();
  assert.equal(context.mediaStream, oldStream);
  assert.equal(context.trackMicDevice.value, 'old');
  assert.deepEqual(events, []);
});

test('disables microphone changes throughout recording, preparation, and saving', () => {
  const availabilitySource = source.slice(source.indexOf('function updateRecordButtonAvailability()'), source.indexOf('function clearRecordingTrackMonitor()'));
  for (const state of ['recording', 'starting', 'finalizing', 'switchingMicrophone', 'detectingDevices', 'readiness']) {
    const context = vm.createContext({
      recordingController: { snapshot: { state: ['recording', 'starting', 'finalizing'].includes(state) ? state : 'idle', recording: state === 'recording', starting: state === 'starting', finalizing: state === 'finalizing' } },
      switchingMicrophone: state === 'switchingMicrophone', detectingDevices: state === 'detectingDevices',
      deletingSession: false, activeSession: null,
      sessionLimitReached: false, roomCall: { readinessCheckInProgress: state === 'readiness', isActive: false },
      trackMicDevice: { value: 'device', disabled: false }, deleteSessionButton: {}, recordButton: {},
      $: () => context.deleteSessionButton
    });
    vm.runInContext(availabilitySource, context);
    context.updateRecordButtonAvailability();
    assert.equal(context.trackMicDevice.disabled, true, state);
    context[state] = false;
    context.recordingController.snapshot.state = 'idle';
    context.recordingController.snapshot.recording = false;
    context.recordingController.snapshot.starting = false;
    context.recordingController.snapshot.finalizing = false;
    context.roomCall.readinessCheckInProgress = false;
    context.updateRecordButtonAvailability();
    assert.equal(context.trackMicDevice.disabled, false, state);
  }
});

test('explicit call replacement uses the new track without acquiring another stream', async () => {
  const track = {};
  const stream = { getAudioTracks: () => [track] };
  const events = [];
  const call = {
    connected: true, authFields: { generation: 'authenticated' },
    localSender: {
      replaceTrack: async (replacement) => { assert.equal(replacement, track); events.push('replace'); },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async (parameters) => { assert.equal(parameters.encodings[0].maxBitrate, 32000); }
    },
    getMicrophoneStream: () => assert.fail('should use supplied stream'),
    onLocalStream: (replacement) => { assert.equal(replacement, stream); events.push('preview'); }
  };
  await RoomCall.prototype.attachLocalAudio.call(call, stream);
  assert.deepEqual(events, ['replace', 'preview']);
});

test('rejects explicit call replacement before authentication', async () => {
  await assert.rejects(RoomCall.prototype.attachLocalAudio.call({ connected: false }, {}), /authenticated/u);
});

test('keeps initial call attachment using the shared capture stream', async () => {
  const track = {};
  const stream = { getAudioTracks: () => [track] };
  let acquired = 0;
  await RoomCall.prototype.attachLocalAudio.call({
    getMicrophoneStream: async () => { acquired += 1; return stream; },
    localSender: {
      replaceTrack: async (replacement) => assert.equal(replacement, track),
      getParameters: () => ({}),
      setParameters: async (parameters) => assert.equal(parameters.encodings[0].maxBitrate, 32000)
    }
  });
  assert.equal(acquired, 1);
});

test('shows microphone selection only beside the local waveform and removes diagnostics', () => {
  const html = readFileSync(new URL('../prototype/recorder.html', import.meta.url), 'utf8');
  assert.equal(html.includes('audioTrackSettings'), false);
  assert.equal(html.includes('Microphone settings (per track)'), false);
  assert.match(html, /<select id="trackMicDevice" aria-label="Recording microphone" aria-describedby="trackMicDeviceHint">/);
  assert.equal(html.includes('自分の録音マイク（入力1 / L）'), false);
  assert.match(html, /id="microphoneMuteButton"[^>]*>MUTE<\/button>/);
  assert.equal(html.includes('<span class="meter-label">入力レベル</span>'), false);
  assert.equal(html.includes('id="meterHint"'), false);
  assert.match(html, /class="meter remote-waveform-meter"/);
  const remoteTemplate = html.slice(html.indexOf('<template id="remoteWaveformTemplate"'));
  assert.match(remoteTemplate, /<div class="waveform-input-controls">[\s\S]*?<label class="field waveform-device-field remote-waveform-device-field">[\s\S]*?<select class="remote-waveform-device"[^>]*disabled/);
  assert.match(remoteTemplate, /class="waveform-heading-control">[\s\S]*?class="remote-mute-state wait" aria-live="polite"[\s\S]*?class="waveform-track-title"/);
  assert.match(remoteTemplate, /class="waveform-ruler-row remote-waveform-ruler-row">[\s\S]*?class="waveform-ruler-spacer"[\s\S]*?class="waveform-timeline"/);
  assert.match(remoteTemplate, /class="waveform-visual-row remote-waveform-visual-row">[\s\S]*?class="meter-block remote-meter-block">[\s\S]*?class="meter remote-waveform-meter"[\s\S]*?waveform-canvas-wrap/);
  assert.match(html, /<h3 id="waveformParticipant"><\/h3>/);
  assert.match(remoteTemplate, /<h3 class="remote-waveform-participant"><\/h3>/);
  for (const label of ['自分のトラック', 'ホストのトラック', 'ゲストのトラック', 'この端末の入力']) {
    assert.equal(html.includes(label), false);
    assert.equal(source.includes(label), false);
  }
  assert.equal(remoteTemplate.includes('trackMicDevice'), false);
});
