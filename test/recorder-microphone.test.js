import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RoomCall } from '../prototype/room-call.js';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const changeMicrophoneSource = source.slice(source.indexOf('async function changeMicrophone()'), source.indexOf('async function checkRecordingReadiness()'));
const openSessionSource = source.slice(source.indexOf('async function openSession(session)'), source.indexOf('async function detectDevices'));

function setupSession({ failure = false, recording = false, leaveDuringCapture = false } = {}) {
  const events = [];
  const elements = new Map();
  const stream = {};
  const context = vm.createContext({
    activeSession: null, roomCall: null, recording, starting: false,
    waveformHistory: new Float32Array(1), waveformCount: 0, waveformElapsedSeconds: 0,
    lastRulerSecond: -1, waveformFrame: null, sessionLimitReached: false, MAX_SESSION_FRAMES: 100,
    setupView: {}, studioView: { hidden: true }, errorText: {},
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { classList: { remove() {} } });
      return elements.get(id);
    },
    drawWaveform: () => events.push('draw'), setStatus: () => {},
    renderTakes: async () => {}, loadAll: async () => [], updateRecordButtonAvailability: () => {},
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
  assert.deepEqual(events, ['draw', 'capture', 'preview']);
  assert.equal(context.studioView.hidden, false);
});

test('keeps the session open and reports microphone acquisition failures', async () => {
  const { context, events } = setupSession({ failure: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.equal(context.studioView.hidden, false);
  assert.deepEqual(events, ['draw', 'capture', 'マイク待機中']);
  assert.match(context.errorText.textContent, /permission denied/);
});

test('does not reacquire capture when opening a session during recording', async () => {
  const { context, events } = setupSession({ recording: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.deepEqual(events, ['draw']);
});

test('releases delayed capture if the user leaves the session before permission resolves', async () => {
  const { context, events } = setupSession({ leaveDuringCapture: true });
  await context.openSession({ id: 'session', participant: 'Participant' });
  assert.deepEqual(events, ['draw', 'capture', 'release']);
});

function setup({ blocked = false, connected = false, failure = null } = {}) {
  const events = [];
  const hint = {};
  const oldStream = { getTracks: () => [{ stop: () => events.push('stop-old') }] };
  const newStream = { getTracks: () => [{ stop: () => events.push('stop-new') }] };
  const context = vm.createContext({
    micDevice: { value: 'old' },
    trackMicDevice: { value: 'new', disabled: blocked },
    mediaStream: oldStream,
    switchingMicrophone: false,
    roomCall: connected ? {
      connected: true,
      checkLocalReadiness: async () => events.push('readiness'),
      attachLocalAudio: async (stream) => {
        assert.equal(stream, newStream);
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
      assert.equal(stream, newStream);
      events.push('preview');
    }
  });
  vm.runInContext(changeMicrophoneSource, context);
  return { context, events, hint, oldStream, newStream };
}

test('switches local capture and preview before stopping the old microphone', async () => {
  const { context, events, newStream } = setup();
  await context.changeMicrophone();
  assert.equal(context.mediaStream, newStream);
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
    assert.equal(context.mediaStream, oldStream);
    assert.equal(context.micDevice.value, 'old');
    assert.equal(context.trackMicDevice.value, 'old');
    assert.equal(context.switchingMicrophone, false);
    assert.equal(events.includes('stop-old'), false);
    assert.equal(events.includes('stop-new'), failure === 'replace');
    assert.match(hint.textContent, /マイクを変更できませんでした/);
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
      recording: state === 'recording', starting: state === 'starting', finalizing: state === 'finalizing',
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
  await assert.rejects(RoomCall.prototype.attachLocalAudio.call({ connected: false }, {}), /認証済み/);
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
  assert.equal(html.includes('マイク設定（トラック別）'), false);
  assert.match(html, /<select id="trackMicDevice" aria-describedby="trackMicDeviceHint">/);
  assert.equal(html.slice(html.indexOf('<template id="remoteWaveformTemplate"')).includes('trackMicDevice'), false);
});
