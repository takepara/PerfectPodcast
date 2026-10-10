import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomCall } from '../prototype/room-call.js';
import { RoomSignaling } from '../worker/index.js';
import { calculateClockSample } from '../prototype/clock-sync.js';

for (const offset of [-600000, 600000]) {
  test(`host, relay and guest accept a valid ${offset} ms page-clock offset`, async () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalWindow = globalThis.window;
    globalThis.WebSocket = { OPEN: 1 };
    globalThis.window = { setTimeout: () => 1, clearTimeout() {} };
    try {
      const generation = '0123456789abcdefghij_-';
      const eventId = '123e4567-e89b-42d3-a456-426614174000';
      const target = performance.now() + 610000;
      const host = Object.create(RoomCall.prototype);
      let command;
      Object.assign(host, {
        localRole: 'host', connected: true, localReady: true, remoteReady: true,
        socket: { readyState: 1 }, peerConnection: { connectionState: 'connected' },
        authFields: { generation }, recordingSequence: 0,
        pendingRecordingCommands: new Map(), pendingStartEvents: new Map(),
        cancelPendingTurnCredentials() {}, getRecordingState: () => false,
        setStatus() {}, sendRecordingCommand(value) { command = value; }
      });
      const accepted = host.setHostRecordingState(true, target, offset, eventId, Date.now() + 500);
      assert.ok(accepted, 'valid page-clock offset must not be rejected');
      const message = {
        type: 'recording-state', recording: true, eventId, sequence: command.sequence,
        generation, startAt: target, clockOffsetMs: offset, hostStartedAt: command.hostStartedAt
      };
      const socket = () => ({ readyState: 1, messages: [],
        send(value) { this.messages.push(JSON.parse(value)); }, close() { this.readyState = 3; } });
      const hostSocket = socket(), guestSocket = socket();
      const relay = new RoomSignaling({});
      relay.peers.set(hostSocket, 'host');
      relay.peers.set(guestSocket, 'guest');
      relay.authenticatedSubjects.set(hostSocket, { sub: 'auth0|clock-test', exp: Math.floor(Date.now() / 1000) + 600 });
      await relay.onMessage(hostSocket, { data: JSON.stringify(message) });
      assert.deepEqual(guestSocket.messages, [message]);
      assert.equal(hostSocket.readyState, 1);
      let schedule;
      const replies = [];
      const guest = Object.create(RoomCall.prototype);
      Object.assign(guest, {
        localRole: 'guest', connected: true, localReady: true, remoteReady: true,
        socket: { readyState: 1 }, peerConnection: { connectionState: 'connected' },
        authFields: { generation }, guestRecordingCommands: new Map(), lastGuestRecordingSequence: 0,
        pendingGuestRecordingCommand: null, setStatus() {},
        async onRecordingState(_recording, value) { schedule = value; return true; },
        send(value) { replies.push(value); }
      });
      await guest.receiveRecordingState(guestSocket.messages[0]);
      assert.equal(schedule.startAt, target + offset);
      assert.equal(schedule.hostStartedAt, message.hostStartedAt);
      assert.equal(replies[0].accepted, true);
    } finally {
      if (originalWebSocket === undefined) delete globalThis.WebSocket;
      else globalThis.WebSocket = originalWebSocket;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });
}

test('ten-minute page origin difference does not reduce clock measurement accuracy', () => {
  const sample = calculateClockSample(610000, 10001, 10002, 610003);
  assert.equal(sample.offsetMs, -600000);
  assert.equal(sample.roundTripMs, 2);
  assert.equal(610503 + sample.offsetMs, 10503);
});

test('invalid offsets and overflowing converted targets remain rejected by the host', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const host = Object.create(RoomCall.prototype);
    Object.assign(host, { localRole: 'host', connected: true, localReady: true, remoteReady: true,
      socket: { readyState: 1 }, peerConnection: { connectionState: 'connected' },
      getRecordingState: () => false, setStatus() {} });
    for (const [target, offset] of [[performance.now() + 500, NaN], [performance.now() + 500, Infinity], [Number.MAX_VALUE, Number.MAX_VALUE]]) {
      assert.equal(host.setHostRecordingState(true, target, offset), null);
    }
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});
