import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fingerprintFromSdp, invitationProof, RoomCall, transcript } from '../prototype/room-call.js';
import worker, { RoomSignaling } from '../worker/index.js';
import { turnPermitSigningMessage } from '../shared/turn-permit.js';

const execFileAsync = promisify(execFile);

function createTestTurnPermit(roomId, hostPublicKey, signingKey) {
  const now = Date.now();
  const hostKeyHash = createHash('sha256')
    .update(Buffer.from(hostPublicKey, 'base64url'))
    .digest('base64url');
  const payload = {
    v: 1,
    roomId,
    hostKeyHash,
    issuedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    jti: randomBytes(16).toString('base64url'),
    maxGuests: 1
  };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signMessage(
    null,
    Buffer.from(turnPermitSigningMessage(payload)),
    signingKey
  ).toString('base64url');
  return `${payloadPart}.${signature}`;
}

test('reads the DTLS SHA-256 fingerprint from CRLF SDP', () => {
  const fingerprint = 'A1:B2:C3:D4';
  assert.equal(
    fingerprintFromSdp(`v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\na=setup:actpass\r\n`),
    'a1b2c3d4'
  );
});

test('authentication transcript binds both DTLS fingerprints and nonces', () => {
  const fields = {
    roomId: 'room',
    generation: 'generation',
    hostNonce: 'host-nonce',
    guestNonce: 'guest-nonce',
    hostFingerprint: 'host-fingerprint',
    guestFingerprint: 'guest-fingerprint',
    guestPublicKey: 'guest-key'
  };
  assert.notEqual(transcript(fields), transcript({ ...fields, guestFingerprint: 'changed' }));
  assert.notEqual(transcript(fields), transcript({ ...fields, hostNonce: 'changed' }));
});

test('invitation proof is bound to its room, nonce, and guest key', async () => {
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const proof = await invitationProof(secret, 'room-a', 'nonce-a', 'guest-key', 1000);
  assert.equal(await invitationProof(secret, 'room-a', 'nonce-a', 'guest-key', 1000), proof);
  assert.notEqual(await invitationProof(secret, 'room-b', 'nonce-a', 'guest-key', 1000), proof);
  assert.notEqual(await invitationProof(secret, 'room-a', 'nonce-b', 'guest-key', 1000), proof);
  assert.notEqual(await invitationProof(secret, 'room-a', 'nonce-a', 'other-key', 1000), proof);
  assert.notEqual(await invitationProof(secret, 'room-a', 'nonce-a', 'guest-key', 1001), proof);
});

test('only the host can relay valid recording-state messages', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');

    const recordingState = {
      type: 'recording-state',
      recording: true,
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation: '0123456789abcdefghij_-',
      startAt: 1000,
      clockOffsetMs: 0
    };
    await signaling.onMessage(host, { data: JSON.stringify(recordingState) });
    assert.deepEqual(guest.messages, [recordingState]);

    const recordingAck = {
      type: 'recording-ack',
      recording: true,
      eventId: recordingState.eventId,
      sequence: recordingState.sequence,
      generation: recordingState.generation,
      accepted: true
    };
    await signaling.onMessage(guest, { data: JSON.stringify(recordingAck) });
    assert.deepEqual(host.messages, [recordingAck]);

    await signaling.onMessage(guest, { data: JSON.stringify({ type: 'recording-state', recording: false }) });
    assert.equal(guest.readyState, 3);
    assert.equal(host.messages.some((message) => message.type === 'recording-state'), false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rejects malformed host recording-state messages', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const host = {
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  };
  try {
    const guest = { readyState: 1, messages: [], send(message) { this.messages.push(JSON.parse(message)); }, close() { this.readyState = 3; } };
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');

    await signaling.onMessage(host, { data: JSON.stringify({
      type: 'recording-state',
      recording: 'yes',
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation: '0123456789abcdefghij_-',
      startAt: 1000,
      clockOffsetMs: 0
    }) });
    assert.equal(host.readyState, 3);
    assert.equal(guest.messages.length, 0);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('does not allow guests to publish host recording-state events', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const host = { readyState: 1, send() {}, close() { this.readyState = 3; } };
    const guest = { readyState: 1, send() {}, close() { this.readyState = 3; } };
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    await signaling.onMessage(guest, { data: JSON.stringify({
      type: 'recording-state',
      recording: false,
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation: '0123456789abcdefghij_-'
    }) });
    assert.equal(guest.readyState, 3);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('only the guest can acknowledge a valid recording event', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    const ack = {
      type: 'recording-ack',
      recording: true,
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation: '0123456789abcdefghij_-',
      accepted: true
    };

    await signaling.onMessage(host, { data: JSON.stringify(ack) });
    assert.equal(host.readyState, 3);
    assert.equal(guest.messages.length, 0);

    const anotherHost = makeSocket();
    const anotherGuest = makeSocket();
    const secondSignaling = new RoomSignaling({});
    secondSignaling.peers.set(anotherHost, 'host');
    secondSignaling.peers.set(anotherGuest, 'guest');
    await secondSignaling.onMessage(anotherGuest, { data: JSON.stringify(ack) });
    assert.deepEqual(anotherHost.messages, [ack]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rejects malformed recording acknowledgements', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const guest = {
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  };
  try {
    const host = { readyState: 1, messages: [], send(message) { this.messages.push(message); }, close() {} };
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    await signaling.onMessage(guest, { data: JSON.stringify({
      type: 'recording-ack',
      recording: true,
      eventId: 'invalid',
      sequence: 1,
      accepted: true
    }) });
    assert.equal(guest.readyState, 3);
    assert.equal(host.messages.some((message) => JSON.parse(message).type === 'recording-ack'), false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('relays readiness only with a valid authenticated-generation shape', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    const ready = {
      type: 'ready-state',
      ready: true,
      generation: '0123456789abcdefghij_-',
      sequence: 1
    };

    await signaling.onMessage(guest, { data: JSON.stringify(ready) });
    assert.deepEqual(host.messages, [ready]);

    await signaling.onMessage(host, { data: JSON.stringify({ ...ready, ready: false, sequence: 2 }) });
    assert.equal(guest.messages[0].ready, false);
    assert.equal(guest.messages[0].sequence, 2);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rejects malformed readiness states', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const host = {
      readyState: 1,
      messages: [],
      send(message) { this.messages.push(JSON.parse(message)); },
      close() { this.readyState = 3; }
    };
    const guest = { readyState: 1, send() {}, close() { this.readyState = 3; } };
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');

    await signaling.onMessage(host, { data: JSON.stringify({
      type: 'ready-state',
      ready: 'yes',
      generation: 'invalid',
      sequence: 0
    }) });
    assert.equal(host.readyState, 3);
    assert.equal(guest.readyState, 3);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('relays bounded transfer progress from an approved guest', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    signaling.approvedGuest = true;
    const progress = {
      type: 'transfer-progress',
      generation: '0123456789abcdefghij_-',
      sequence: 1,
      localBytes: 300,
      hostStoredBytes: 100,
      pendingBytes: 200,
      totalFrames: 100,
      hostStoredFrames: 40,
      pendingFrames: 60,
      unsubmittedBytes: 120,
      sendingBytes: 0,
      awaitingAckBytes: 80,
      sendState: 'awaiting-ack',
      bufferedBytes: 16_384,
      sendMbps: 1.25
    };

    await signaling.onMessage(guest, { data: JSON.stringify(progress) });
    assert.deepEqual(host.messages, [progress]);

    await signaling.onMessage(guest, { data: JSON.stringify({ ...progress, sequence: 2 }) });
    assert.equal(guest.readyState, 3);
    assert.deepEqual(host.messages, [progress, { type: 'peer-left' }]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rejects invalid or unapproved guest transfer progress', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    const progress = {
      type: 'transfer-progress',
      generation: '0123456789abcdefghij_-',
      sequence: 1,
      localBytes: 300,
      hostStoredBytes: 100,
      pendingBytes: 200,
      totalFrames: 100,
      hostStoredFrames: 40,
      pendingFrames: 60,
      unsubmittedBytes: 121,
      sendingBytes: 0,
      awaitingAckBytes: 79,
      sendState: 'awaiting-ack',
      bufferedBytes: 0,
      sendMbps: null
    };

    await signaling.onMessage(guest, { data: JSON.stringify(progress) });
    assert.equal(guest.readyState, 3);
    assert.deepEqual(host.messages, [{ type: 'peer-left' }]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('accepts only fresh transfer progress for the authenticated room generation', () => {
  const call = Object.create(RoomCall.prototype);
  Object.assign(call, {
    localRole: 'host',
    connected: true,
    authFields: { generation: '0123456789abcdefghij_-' },
    remoteTransferProgress: null
  });
  const progress = {
    generation: '0123456789abcdefghij_-',
    sequence: 2,
    unsubmittedBytes: 120,
    sendingBytes: 0,
    awaitingAckBytes: 80
  };

  call.receiveTransferProgress({ ...progress, generation: 'another-generation' });
  assert.equal(call.remoteTransferProgress, null);
  call.receiveTransferProgress(progress);
  const received = call.remoteTransferProgress;
  assert.equal(received.sequence, 2);
  assert.ok(Number.isFinite(received.receivedAt));
  call.receiveTransferProgress({ ...progress, sequence: 1 });
  assert.equal(call.remoteTransferProgress, received);
});

test('measures recording DataChannel send bitrate from WebRTC stats deltas', async () => {
  const originalDocument = globalThis.document;
  const statsElement = { hidden: false, textContent: '' };
  globalThis.document = { getElementById: () => statsElement };
  let sentBytes = 100_000;
  let timestamp = 1_000;
  const peerConnection = {
    connectionState: 'connected',
    async getStats() {
      return new Map([['data-channel', {
        type: 'data-channel',
        id: 'data-channel',
        label: 'master-transfer-v1',
        bytesSent: sentBytes,
        timestamp
      }]]);
    }
  };
  const call = Object.create(RoomCall.prototype);
  Object.assign(call, {
    peerConnection,
    statsRefreshInProgress: false,
    previousStats: null,
    previousTransferStats: null,
    transferSendMbps: null
  });
  try {
    await call.updateConnectionStats();
    assert.equal(call.transferSendMbps, null);
    sentBytes += 200_000;
    timestamp += 2_000;
    await call.updateConnectionStats();
    assert.equal(call.transferSendMbps, 0.8);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('ignores readiness from another generation and stale readiness sequences', () => {
  const call = Object.create(RoomCall.prototype);
  Object.assign(call, {
    connected: true,
    authFields: { generation: '0123456789abcdefghij_-' },
    remoteReadySequence: 0,
    remoteReady: false,
    localReady: true,
    updates: 0,
    updateReadinessUI() { this.updates += 1; },
    setStatus() {}
  });

  call.receiveReadyState({
    ready: true,
    generation: 'another-generation_______',
    sequence: 1
  });
  assert.equal(call.remoteReady, false);
  assert.equal(call.updates, 0);

  call.receiveReadyState({
    ready: true,
    generation: call.authFields.generation,
    sequence: 2
  });
  call.receiveReadyState({
    ready: false,
    generation: call.authFields.generation,
    sequence: 1
  });
  assert.equal(call.remoteReady, true);
  assert.equal(call.remoteReadySequence, 2);
  assert.equal(call.updates, 1);
});

test('host recording requires both readiness checks and an active peer connection', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      localRole: 'host',
      socket: { readyState: 1 },
      connected: true,
      localReady: true,
      remoteReady: true,
      peerConnection: { connectionState: 'connecting' }
    });
    assert.equal(call.canStartRecording, false);
    call.peerConnection.connectionState = 'connected';
    assert.equal(call.canStartRecording, true);
    call.remoteReady = false;
    assert.equal(call.canStartRecording, false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('host can record locally while the invited room is waiting for a guest', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      localRole: 'host',
      socket: { readyState: 1 },
      pendingGuest: null,
      peerConnection: null,
      connected: false,
      localReady: false,
      remoteReady: false
    });
    assert.equal(call.canStartRecording, true);

    call.pendingGuest = { name: 'Guest' };
    assert.equal(call.canStartRecording, false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('guest does not start recording before readiness and transport checks pass', async () => {
  let started = false;
  let resolved = false;
  const call = Object.create(RoomCall.prototype);
  Object.assign(call, {
    connected: true,
    localReady: false,
    remoteReady: true,
    onRecordingState: async () => { started = true; return true; },
    setStatus() {}
  });

  const command = {
    recording: true,
    accepted: false,
    promise: null,
    resolveResult() { resolved = true; }
  };

  await call.applyGuestRecordingCommand(command);
  assert.equal(started, false);
  assert.equal(command.accepted, false);
  assert.equal(resolved, true);
});

test('confirms both actual recording starts after converting the guest clock', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { clearTimeout() {} };
  try {
    const call = Object.create(RoomCall.prototype);
    const pending = {
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 2,
      clockOffsetMs: 25,
      localStartedAt: 1000,
      remoteStartedAt: null,
      timer: 1
    };
    Object.assign(call, {
      localRole: 'host',
      authFields: { generation: '0123456789abcdefghij_-' },
      pendingStartEvents: new Map([[pending.eventId, pending]]),
      status: null,
      setStatus(message, isError = false) { this.status = { message, isError }; }
    });

    call.receiveRecordingStarted({
      eventId: pending.eventId,
      sequence: pending.sequence,
      generation: call.authFields.generation,
      observedAt: 1025,
      frame: 0
    });
    assert.equal(call.pendingStartEvents.size, 0);
    assert.match(call.status.message, /開始差 0 ms/u);
    assert.equal(call.status.isError, false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('acknowledges duplicate scheduled starts even after their target time', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const eventId = '123e4567-e89b-42d3-a456-426614174000';
    const generation = '0123456789abcdefghij_-';
    const sent = [];
    const prior = {
      eventId,
      sequence: 1,
      generation,
      recording: true,
      startAt: 520,
      clockOffsetMs: 20,
      accepted: true,
      resultPromise: Promise.resolve()
    };
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      localRole: 'guest',
      authFields: { generation },
      guestRecordingCommands: new Map([[eventId, prior]]),
      socket: { readyState: 1, send(message) { sent.push(JSON.parse(message)); } },
      setStatus() {}
    });

    await call.receiveRecordingState({
      type: 'recording-state',
      eventId,
      sequence: 1,
      generation,
      recording: true,
      startAt: 500,
      clockOffsetMs: 20
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].accepted, true);
    assert.equal(sent[0].eventId, eventId);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('issues short-lived TURN credentials only after host approval and caches them in memory', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  let fetchCount = 0;
  const permitKeys = generateKeyPairSync('ed25519');
  const permitPublicKey = permitKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const roomId = 'A'.repeat(43);
  const hostPublicKey = Buffer.alloc(91, 4).toString('base64url');
  const permit = createTestTurnPermit(roomId, hostPublicKey, permitKeys.privateKey);
  globalThis.fetch = async (url, init) => {
    fetchCount += 1;
    assert.match(String(url), /rtc\.live\.cloudflare\.com\/v1\/turn\/keys\/test-key\/credentials/u);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(init.body).ttl, 10_800);
    return Response.json({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'short-lived-user',
          credential: 'short-lived-password'
        }
      ]
    });
  };
  try {
    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({}, {
      TURN_API_TOKEN: 'test-token',
      TURN_KEY_ID: 'test-key',
      TURN_PERMIT_PUBLIC_KEY: permitPublicKey
    });
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    signaling.roomId = roomId;
    signaling.turnRateLimitConfigured = true;

    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    await signaling.onMessage(host, {
      data: JSON.stringify({ type: 'turn-request', requestId, permit, hostPublicKey })
    });
    assert.equal(fetchCount, 0);
    assert.equal(host.readyState, 3);

    const approvedHost = makeSocket();
    const approvedGuest = makeSocket();
    const approvedSignaling = new RoomSignaling({}, {
      TURN_API_TOKEN: 'test-token',
      TURN_KEY_ID: 'test-key',
      TURN_PERMIT_PUBLIC_KEY: permitPublicKey
    });
    approvedSignaling.peers.set(approvedHost, 'host');
    approvedSignaling.peers.set(approvedGuest, 'guest');
    approvedSignaling.roomId = roomId;
    approvedSignaling.turnRateLimitConfigured = true;
    await approvedSignaling.onMessage(approvedHost, { data: JSON.stringify({ type: 'approved' }) });
    const otherRoomPermit = createTestTurnPermit(
      'D'.repeat(43),
      hostPublicKey,
      permitKeys.privateKey
    );
    await approvedSignaling.onMessage(approvedHost, {
      data: JSON.stringify({
        type: 'turn-request',
        requestId,
        permit: otherRoomPermit,
        hostPublicKey
      })
    });
    assert.equal(approvedHost.messages.at(-1).type, 'turn-error');
    assert.equal(fetchCount, 0);
    assert.equal(approvedGuest.messages.at(-1).type, 'turn-error');
    await approvedSignaling.onMessage(approvedHost, {
      data: JSON.stringify({
        type: 'turn-request',
        requestId: '323e4567-e89b-42d3-a456-426614174002',
        permit,
        hostPublicKey: Buffer.alloc(91, 7).toString('base64url')
      })
    });
    assert.equal(approvedHost.messages.at(-1).type, 'turn-error');
    assert.equal(fetchCount, 0);
    await approvedSignaling.onMessage(approvedHost, {
      data: JSON.stringify({ type: 'turn-request', requestId, permit, hostPublicKey })
    });
    assert.equal(fetchCount, 1);
    assert.deepEqual(approvedHost.messages.at(-1), {
      type: 'turn-credentials',
      requestId,
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'short-lived-user',
          credential: 'short-lived-password'
        }
      ]
    });
    assert.deepEqual(approvedGuest.messages.at(-1), approvedHost.messages.at(-1));

    await approvedSignaling.onMessage(approvedHost, {
      data: JSON.stringify({
        type: 'turn-request',
        requestId: '223e4567-e89b-42d3-a456-426614174001',
        permit,
        hostPublicKey
      })
    });
    assert.equal(fetchCount, 1);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test('reports missing TURN API configuration without exposing an API secret', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const permitKeys = generateKeyPairSync('ed25519');
  const permitPublicKey = permitKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const roomId = 'B'.repeat(43);
  const hostPublicKey = Buffer.alloc(91, 5).toString('base64url');
  const permit = createTestTurnPermit(roomId, hostPublicKey, permitKeys.privateKey);
  const host = {
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  };
  const guest = {
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  };
  try {
    const signaling = new RoomSignaling({}, { TURN_PERMIT_PUBLIC_KEY: permitPublicKey });
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    signaling.roomId = roomId;
    await signaling.onMessage(host, { data: JSON.stringify({ type: 'approved' }) });
    await signaling.onMessage(host, {
      data: JSON.stringify({
        type: 'turn-request',
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        permit,
        hostPublicKey
      })
    });
    assert.equal(host.messages.at(-1).type, 'turn-error');
    assert.deepEqual(guest.messages.at(-1), host.messages.at(-1));
    assert.match(host.messages.at(-1).message, /未設定/u);
    assert.equal(host.messages.at(-1).message.includes('Bearer'), false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rate limits signaling connections before forwarding them to a room', async () => {
  const roomId = 'F'.repeat(43);
  const rateLimitKeys = [];
  let allow = true;
  let forwarded = 0;
  const env = {
    SIGNAL_RATE_LIMITER: {
      async limit({ key }) {
        rateLimitKeys.push(key);
        return { success: allow };
      }
    },
    ROOMS: {
      getByName(name) {
        assert.equal(name, roomId);
        return {
          async fetch(request) {
            forwarded += 1;
            assert.equal(request.headers.get('x-signal-rate-limit-configured'), 'true');
            return new Response('forwarded');
          }
        };
      }
    }
  };
  const makeRequest = () => new Request(`https://pod.test/signal/${roomId}`, {
    headers: {
      Upgrade: 'websocket',
      'CF-Connecting-IP': '192.0.2.50'
    }
  });

  const first = await worker.fetch(makeRequest(), env);
  assert.equal(await first.text(), 'forwarded');
  allow = false;
  const second = await worker.fetch(makeRequest(), env);
  assert.equal(second.status, 429);
  assert.deepEqual(rateLimitKeys, ['192.0.2.50', '192.0.2.50']);
  assert.equal(forwarded, 1);
});

test('creates a host-bound room permit with the offline signing tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perfectpodcast-turn-permit-'));
  const privateKeyPath = join(directory, 'permit-key.pem');
  try {
    const keypair = await execFileAsync(process.execPath, [
      'scripts/create-turn-permit-keypair.js',
      privateKeyPath
    ]);
    const roomId = 'C'.repeat(43);
    const hostPublicKey = Buffer.alloc(91, 6).toString('base64url');
    const result = await execFileAsync(
      process.execPath,
      ['scripts/create-turn-permit.js', roomId, hostPublicKey],
      { env: { ...process.env, TURN_PERMIT_PRIVATE_KEY_PATH: privateKeyPath } }
    );
    const [payloadPart, signaturePart] = result.stdout.trim().split('.');
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    assert.equal(payload.roomId, roomId);
    assert.equal(payload.hostKeyHash, createHash('sha256')
      .update(Buffer.from(hostPublicKey, 'base64url'))
      .digest('base64url'));
    assert.equal(payload.maxGuests, 1);
    assert.ok(payload.expiresAt > payload.issuedAt);
    assert.equal(
      verifyMessage(
        null,
        Buffer.from(turnPermitSigningMessage(payload)),
        createPublicKey({
          key: Buffer.from(keypair.stdout.trim(), 'base64url'),
          format: 'der',
          type: 'spki'
        }),
        Buffer.from(signaturePart, 'base64url')
      ),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
