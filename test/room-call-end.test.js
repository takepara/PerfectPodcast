import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomCall } from '../prototype/room-call.js';
import { RoomSignaling } from '../worker/index.js';

function setup() {
  const original = { window: globalThis.window, document: globalThis.document, WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection };
  const timers = new Map();
  let timerId = 0;
  const elements = new Map();
  globalThis.window = { location: { href: 'https://localhost/' },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { hidden: false, classList: { toggle() {} }, srcObject: null });
    return elements.get(id);
  } };
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; Socket.latest = this; }
    send() {}
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }));
    }
  }
  globalThis.WebSocket = Socket;
  const events = [], releases = [], recordings = [], transfer = [];
  const call = Object.create(RoomCall.prototype);
  const peer = new EventTarget();
  peer.closed = false;
  peer.close = () => { peer.closed = true; };
  Object.assign(call, {
    localRole: 'guest', connected: true, localReady: true, remoteReady: true,
    peerConnection: peer, guestRecordingPreparations: new Map(), pendingRecordingCommands: new Map(),
    guestRecordingCommands: new Map(), inviteMode: true, invitation: {},
    recordingTransfer: { close: () => transfer.push('closed') },
    getRecordingState: () => false,
    onRecordingState: async (state) => recordings.push(state),
    releaseMicrophone: async () => releases.push('release'), onLocalStream() {},
    clearPendingClockProbes() {}, clearPendingRecordingPreparations() { call.guestRecordingPreparations.clear(); },
    clearPendingStartEvents() {}, stopConnectionStats() {}, stopRemoteWaveform() {}, setRemoteWaveState() {},
    updateReadinessUI() {}, setCallState: (message) => events.push({ state: message }),
    setStatus: (message, error = false) => events.push({ status: message, error }),
    logNetworkEvent: (event, details) => events.push({ event, details }),
    receiveInputMonitorMessage: () => events.push({ message: true })
  });
  const monitor = new EventTarget();
  monitor.readyState = 'open';
  monitor.send = () => {};
  monitor.close = () => {
    monitor.readyState = 'closed';
    monitor.dispatchEvent(new Event('error'));
    monitor.dispatchEvent(new Event('close'));
  };
  call.updateRemoteInputMonitor = () => {};
  call.localInputMonitorState = { level: 0, muted: false, deviceLabel: '' };
  call.setInputMonitorChannel(monitor);
  return { call, peer, monitor, events, recordings, releases, transfer, Socket, timers,
    async open() {
      const promise = call.openSocket('room', 'guest');
      Socket.latest.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'joined' }) }));
      await promise; return Socket.latest;
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    restore() { for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    } }
  };
}

test('host End Call closes the guest call normally even if channel error arrives first', async () => {
  const env = setup();
  try {
    const socket = await env.open();
    env.monitor.readyState = 'closing';
    env.monitor.dispatchEvent(new Event('error'));
    const signaling = new RoomSignaling({});
    const host = { readyState: 1 };
    signaling.peers.set(host, 'host'); signaling.peers.set(socket, 'guest');
    signaling.onClose(host);
    await env.flush();
    assert.equal(env.peer.closed, true);
    assert.equal(env.call.peerConnection, null);
    assert.equal(env.call.inputMonitorChannel, null);
    assert.equal(env.call.localRole, null);
    assert.deepEqual(env.transfer, ['closed']);
    assert.deepEqual(env.recordings, []);
    assert.ok(env.events.some((event) => event.status?.startsWith('The host ended the call.')));
    assert.equal(env.events.some((event) => event.error), false);
    assert.equal(env.events.some((event) => event.state?.startsWith('Connection lost')), false);
    env.monitor.dispatchEvent(new Event('error'));
    env.monitor.dispatchEvent(Object.assign(new Event('message'), { data: '{}' }));
    await env.flush();
    assert.equal(env.events.some((event) => event.error || event.message), false);
  } finally { env.restore(); }
});

test('guest End Call cleans up the host peer without errors and keeps the invitation available', async () => {
  const env = setup();
  try {
    env.call.localRole = 'host';
    env.call.incomingMessageChain = Promise.resolve();
    env.call.cancelPendingTurnCredentials = () => {};
    env.call.getRecordingState = () => true;
    const messages = [];
    const host = { readyState: 1, send(data) {
      const message = JSON.parse(data); messages.push(message);
      this.handling = env.call.handleMessage(message);
    } };
    const guest = { readyState: 3 };
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host'); signaling.peers.set(guest, 'guest');
    env.monitor.readyState = 'closing';
    env.monitor.dispatchEvent(new Event('error'));
    signaling.onClose(guest);
    await host.handling;
    await env.flush();
    assert.deepEqual(messages, [{ type: 'peer-left' }]);
    assert.equal(env.peer.closed, true);
    assert.equal(env.call.peerConnection, null);
    assert.equal(env.call.inputMonitorChannel, null);
    assert.equal(env.call.localRole, 'host');
    assert.deepEqual(env.recordings, []);
    assert.equal(env.events.some((event) => event.error), false);
    assert.ok(env.events.some((event) => event.state?.includes('Waiting for a new join request')));
    env.monitor.dispatchEvent(new Event('error'));
    env.monitor.dispatchEvent(Object.assign(new Event('message'), { data: '{}' }));
    await env.flush();
    assert.equal(env.events.some((event) => event.error || event.message), false);
  } finally { env.restore(); }
});

test('normal host departure does not issue a stop to an active local recording', async () => {
  const env = setup();
  try {
    env.call.getRecordingState = () => true;
    const socket = await env.open();
    socket.close(1000, 'Host left'); await env.flush();
    assert.deepEqual(env.recordings, []);
    assert.equal(env.peer.closed, true);
  } finally { env.restore(); }
});

test('host departure cancels guest preparation without arming a recording', async () => {
  const env = setup();
  try {
    env.call.guestRecordingPreparations.set('event', {});
    const socket = await env.open(); socket.close(1000, 'Host left'); await env.flush();
    assert.deepEqual(env.recordings, [false]);
    assert.equal(env.peer.closed, true);
    assert.equal(env.call.guestRecordingPreparations.size, 0);
  } finally { env.restore(); }
});

test('a late close from an older signaling socket cannot end a newer call', async () => {
  const env = setup();
  try {
    const old = await env.open();
    await env.open();
    old.close(1000, 'Host left'); await env.flush();
    assert.equal(env.peer.closed, false);
    assert.equal(env.call.localRole, 'guest');
    assert.equal(env.call.remoteHostEnded, false);
  } finally { env.restore(); }
});

for (const [code, reason] of [[1006, ''], [1000, ''], [1000, 'Temporary interruption']]) {
  test(`socket close ${code}/${reason || '(empty)'} is not treated as explicit host departure`, async () => {
    const env = setup();
    try {
      const socket = await env.open(); socket.close(code, reason); await env.flush();
      assert.equal(env.peer.closed, false);
      assert.equal(env.call.localRole, 'guest');
      assert.deepEqual(env.transfer, []);
      assert.ok(env.events.some((event) => event.state?.startsWith('Connection lost')));
      assert.deepEqual(env.recordings, []);
    } finally { env.restore(); }
  });
}

test('an input monitor error on a still-open live channel is still reported', async () => {
  const env = setup();
  try {
    env.monitor.dispatchEvent(new Event('error')); await env.flush();
    assert.ok(env.events.some((event) => event.error && event.status.includes('microphone input level')));
  } finally { env.restore(); }
});

test('late events from a closed or replaced PeerConnection cannot overwrite call state', async () => {
  const env = setup();
  try {
    class Peer extends EventTarget { constructor() { super(); this.connectionState = 'connected'; this.iceConnectionState = 'connected'; } }
    globalThis.RTCPeerConnection = Peer; globalThis.window.RTCPeerConnection = Peer;
    env.call.recordingTransfer.setRole = () => {};
    env.call.recordingTransfer.setChannel = () => {};
    env.call.authFields = null;
    await env.call.createPeerConnection();
    const old = env.call.peerConnection;
    env.call.peerConnection = null;
    const before = env.events.length;
    for (const type of ['connectionstatechange', 'iceconnectionstatechange', 'negotiationneeded', 'signalingstatechange', 'icegatheringstatechange']) old.dispatchEvent(new Event(type));
    assert.equal(env.events.length, before);
    env.call.peerConnection = new Peer();
    old.dispatchEvent(Object.assign(new Event('datachannel'), { channel: {} }));
    assert.equal(env.events.length, before);
  } finally { env.restore(); }
});
