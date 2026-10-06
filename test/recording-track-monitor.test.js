import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorRecordingTrack } from '../prototype/recording-track-monitor.js';

class FakeTrack extends EventTarget {
  muted = false;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createCallbacks() {
  const state = { recording: true, muted: 0, unmuted: 0, ended: 0, timeout: 0 };
  return {
    state,
    callbacks: {
      isRecording: () => state.recording,
      onMuted: () => { state.muted += 1; },
      onUnmuted: () => { state.unmuted += 1; },
      onEnded: () => { state.ended += 1; },
      onMuteTimeout: () => { state.timeout += 1; }
    }
  };
}

test('does not stop for a transient microphone mute that recovers', async () => {
  const track = new FakeTrack();
  const { state, callbacks } = createCallbacks();
  const monitor = monitorRecordingTrack(track, callbacks, 20);

  track.muted = true;
  track.dispatchEvent(new Event('mute'));
  assert.equal(state.muted, 1);
  track.muted = false;
  track.dispatchEvent(new Event('unmute'));
  await delay(30);

  assert.equal(state.unmuted, 1);
  assert.equal(state.timeout, 0);
  monitor.cleanup();
});

test('stops after microphone mute persists through the grace period', async () => {
  const track = new FakeTrack();
  const { state, callbacks } = createCallbacks();
  const monitor = monitorRecordingTrack(track, callbacks, 20);

  track.muted = true;
  track.dispatchEvent(new Event('mute'));
  await delay(30);

  assert.equal(state.timeout, 1);
  monitor.cleanup();
});

test('ignores track events after recording stops and removes listeners on cleanup', () => {
  const track = new FakeTrack();
  const { state, callbacks } = createCallbacks();
  const monitor = monitorRecordingTrack(track, callbacks, 20);

  state.recording = false;
  track.muted = true;
  track.dispatchEvent(new Event('mute'));
  track.dispatchEvent(new Event('ended'));
  monitor.cleanup();
  track.dispatchEvent(new Event('unmute'));

  assert.deepEqual(state, { recording: false, muted: 0, unmuted: 0, ended: 0, timeout: 0 });
});
