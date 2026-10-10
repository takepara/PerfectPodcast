import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordingController, confirmWorkletStop } from '../prototype/recording-controller.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('preparing, prepared, armed and capturing are distinct public states', async () => {
  const states = [];
  const controller = new RecordingController({ onStateChange: (value) => { if (states.at(-1) !== value.state) states.push(value.state); } });
  let token;
  await controller.start(async (operation) => { token = operation; controller.prepared(token); return true; });
  assert.equal(controller.snapshot.state, 'prepared');
  assert.equal(controller.snapshot.onAir, false);
  await controller.start(async (operation) => { assert.equal(operation, token); controller.arm(operation); return true; });
  assert.equal(controller.snapshot.state, 'armed');
  assert.equal(controller.snapshot.recording, true);
  assert.equal(controller.snapshot.onAir, false);
  assert.equal(controller.captured(token), true);
  assert.equal(controller.snapshot.state, 'capturing');
  await controller.stop(async () => true);
  assert.equal(controller.snapshot.state, 'idle');
  assert.deepEqual(states, ['preparing', 'prepared', 'armed', 'capturing', 'finalizing', 'idle']);
});

test('stop during preparation cancels the operation, waits for cleanup and joins repeated stops', async () => {
  const controller = new RecordingController();
  const pending = deferred(); let token, cleanups = 0;
  const start = controller.start(async (operation) => { token = operation; await pending.promise; assert.equal(controller.isCurrent(operation), false); return false; });
  await Promise.resolve();
  const stop = controller.stop(async () => { cleanups += 1; return true; });
  assert.equal(controller.stop(() => { throw new Error('duplicate stop'); }), stop);
  assert.equal(controller.snapshot.state, 'finalizing');
  assert.equal(controller.snapshot.cancelRequested, true);
  assert.equal(controller.captured(token), false);
  assert.equal(cleanups, 0);
  pending.resolve();
  assert.equal(await start, false);
  assert.equal(await stop, true);
  assert.equal(cleanups, 1);
  assert.equal(controller.snapshot.state, 'idle');
});

test('canceling a prepared take never arms it and returns to idle after cleanup', async () => {
  const controller = new RecordingController(); let token;
  await controller.start(async (operation) => { token = operation; controller.prepared(operation); return true; });
  let discarded = 0;
  await controller.stop(async () => { discarded += 1; return true; });
  assert.equal(discarded, 1);
  assert.equal(controller.prepared(token), false);
  assert.throws(() => controller.arm(token), /canceled/);
  assert.equal(controller.snapshot.state, 'idle');
});

test('exit cancellation rejects a delayed first sample even before cleanup', async () => {
  const controller = new RecordingController(); let token;
  await controller.start(async (operation) => { token = operation; controller.arm(operation); return true; });
  controller.cancel();
  assert.equal(controller.captured(token), false);
  await controller.stop(async () => true);
});

test('old take observations and exit-time responses cannot start a later take', async () => {
  const controller = new RecordingController(); let old, current;
  await controller.start(async (token) => { old = token; controller.arm(token); return true; });
  await controller.stop(async () => true);
  await controller.start(async (token) => { current = token; controller.arm(token); return true; });
  assert.equal(controller.captured(old), false);
  assert.equal(controller.snapshot.state, 'armed');
  assert.equal(controller.captured(current), true);
  await controller.stop(async () => true);
  assert.equal(controller.captured(current), false);
});

test('start failure releases the lifecycle and exposes its stage', async () => {
  const controller = new RecordingController();
  await assert.rejects(controller.start(async () => { throw new Error('prepare failed'); }), /prepare failed/);
  assert.equal(controller.snapshot.state, 'idle');
  assert.equal(controller.snapshot.lastFailure.stage, 'start');
});

async function finalizeScenario({ confirmed = true, persistFailure = false, drainFailure = false } = {}) {
  const controller = new RecordingController();
  await controller.start(async (token) => { controller.arm(token); return true; });
  const saves = [], notifications = [], events = [];
  const result = await controller.stop(() => controller.finalize({
    stopCapture: async () => { events.push('stop'); return confirmed ? { frames: 10 } : null; },
    drain: async () => { events.push('drain'); if (drainFailure) throw new Error('chunk save failed'); },
    cleanup: async () => { events.push('cleanup'); },
    persist: async (completion) => { saves.push(completion); if (persistFailure) throw new Error('completion write failed'); return { id: 'take', frames: 10, ...completion }; },
    notify: (take) => notifications.push(take)
  }));
  return { result, saves, notifications, events, controller };
}

test('stop ACK and completion save certify normal finalization once', async () => {
  const { result, saves, notifications, events } = await finalizeScenario();
  assert.equal(result.success, true);
  assert.equal(saves[0].status, 'stopped');
  assert.equal(notifications[0].tailUnknown, false);
  assert.deepEqual(events, ['stop', 'drain', 'cleanup']);
});

test('a finalized take stays successfully saved when transfer notification fails', async () => {
  const controller = new RecordingController();
  const result = await controller.finalize({
    stopCapture: async () => ({ frames: 1 }), drain: async () => {}, cleanup: async () => {},
    persist: async (completion) => ({ id: 'take', ...completion }),
    notify: async () => { throw new Error('channel unavailable'); }
  });
  assert.equal(result.success, true);
  assert.equal(result.completionSaved, true);
  assert.equal(result.take.status, 'stopped');
  assert.equal(result.failure, null);
  assert.equal(result.notificationFailure.stage, 'notification');
});

test('stop timeout cannot certify an unknown tail as normally saved', async () => {
  const { result, saves, notifications } = await finalizeScenario({ confirmed: false });
  assert.equal(result.success, false);
  assert.equal(saves[0].status, 'recovered');
  assert.equal(saves[0].tailUnknown, true);
  assert.equal(notifications[0].status, 'recovered');
});

test('completion transaction failure cannot publish a normal final manifest', async () => {
  const { result, notifications, controller } = await finalizeScenario({ persistFailure: true });
  assert.equal(result.success, false);
  assert.equal(result.completionSaved, false);
  assert.equal(notifications.length, 0);
  assert.equal(controller.snapshot.lastFailure.stage, 'completion');
});

test('chunk save failure still cleans up and persists recovered state', async () => {
  const { result, saves, events } = await finalizeScenario({ drainFailure: true });
  assert.equal(result.success, false);
  assert.equal(saves[0].tailUnknown, true);
  assert.deepEqual(events, ['stop', 'drain', 'cleanup']);
});

test('stop confirmation forwards final audio before ACK and restores the port handler', async () => {
  const events = [];
  const handler = ({ data }) => events.push(data.type);
  const port = { onmessage: handler, postMessage() {
    this.onmessage({ data: { type: 'audio', final: true } });
    this.onmessage({ data: { type: 'stopped', frames: 10 } });
  } };
  const result = await confirmWorkletStop(port);
  assert.equal(result.frames, 10);
  assert.deepEqual(events, ['audio', 'stopped']);
  assert.equal(port.onmessage, handler);
});

test('stop timeout restores the handler and does not accept later ACKs', async () => {
  let fire; const handler = () => {};
  const port = { onmessage: handler, postMessage() {} };
  const promise = confirmWorkletStop(port, { setTimeout(fn) { fire = fn; return 1; }, clearTimeout() {} });
  fire();
  assert.equal(await promise, null);
  assert.equal(port.onmessage, handler);
});
