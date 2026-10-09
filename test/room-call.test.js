import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSelectedIceCandidatePair,
  formatSelectedIceConnectionPath,
  fingerprintFromSdp,
  invitationProof,
  RoomCall,
  transcript
} from '../prototype/room-call.js';
import worker, { RoomSignaling, browserTurnIceServers } from '../worker/index.js';

test('filters browser-blocked Cloudflare TURN ports without discarding valid credentials', () => {
  const servers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user', credential: 'password' }
  ];
  const result = browserTurnIceServers(servers);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1].urls, servers[1].urls.slice(1));
  assert.equal(result[1].credential, 'password');
  assert.equal(browserTurnIceServers([{ urls: ['turn:turn.cloudflare.com:3478'] }]), null);
  assert.deepEqual(browserTurnIceServers([{ urls: ['turn:example.com:3478'], username: 'user', credential: 'password' }]), []);
});

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

test('selects the ICE pair reported by the transport instead of another nominated pair', () => {
  const selected = {
    id: 'relay-pair',
    type: 'candidate-pair',
    state: 'succeeded',
    localCandidateId: 'relay-local',
    remoteCandidateId: 'relay-remote'
  };
  const reports = new Map([
    ['direct-pair', {
      id: 'direct-pair',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true
    }],
    [selected.id, selected],
    ['transport', {
      id: 'transport',
      type: 'transport',
      selectedCandidatePairId: selected.id
    }]
  ]);

  assert.equal(findSelectedIceCandidatePair(reports), selected);
});

test('formats the selected ICE path and identifies a TURN relay', () => {
  const pair = {
    id: 'selected-pair',
    type: 'candidate-pair',
    state: 'succeeded',
    localCandidateId: 'local-candidate',
    remoteCandidateId: 'remote-candidate'
  };
  const reports = new Map([
    [pair.id, pair],
    ['transport', {
      id: 'transport',
      type: 'transport',
      selectedCandidatePairId: pair.id
    }],
    ['local-candidate', {
      id: 'local-candidate',
      type: 'local-candidate',
      candidateType: 'relay',
      protocol: 'udp'
    }],
    ['remote-candidate', {
      id: 'remote-candidate',
      type: 'remote-candidate',
      candidateType: 'srflx',
      protocol: 'udp'
    }]
  ]);

  assert.equal(
    formatSelectedIceConnectionPath(reports),
    'TURN relay · relay/udp → srflx/udp'
  );
  reports.get('local-candidate').candidateType = 'host';
  reports.get('remote-candidate').candidateType = 'host';
  assert.equal(
    formatSelectedIceConnectionPath(reports),
    'Direct · host/udp → host/udp'
  );
  assert.equal(formatSelectedIceConnectionPath(new Map()), null);
});

test('uses selected or nominated ICE pair fields only when transport stats are unavailable', () => {
  const selected = {
    id: 'selected-pair',
    type: 'candidate-pair',
    state: 'succeeded',
    selected: true
  };
  assert.equal(
    findSelectedIceCandidatePair(new Map([
      ['nominated-pair', {
        id: 'nominated-pair',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true
      }],
      [selected.id, selected]
    ])),
    selected
  );
  assert.equal(findSelectedIceCandidatePair(new Map([
    ['unselected-pair', {
      id: 'unselected-pair',
      type: 'candidate-pair',
      state: 'succeeded'
    }]
  ])), null);
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
    signaling.authenticatedSubjects.set(host, {
      sub: 'auth0|host-recording',
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const recordingState = {
      type: 'recording-state',
      recording: true,
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation: '0123456789abcdefghij_-',
      startAt: 1000,
      clockOffsetMs: 0,
      hostStartedAt: Date.now()
    };
    const recordingPrepare = {
      type: 'recording-prepare',
      eventId: recordingState.eventId,
      sequence: recordingState.sequence,
      generation: recordingState.generation
    };
    await signaling.onMessage(host, { data: JSON.stringify(recordingPrepare) });
    assert.deepEqual(guest.messages, [recordingPrepare]);

    const recordingPrepared = {
      type: 'recording-prepared',
      eventId: recordingState.eventId,
      sequence: recordingState.sequence,
      generation: recordingState.generation,
      accepted: true
    };
    await signaling.onMessage(guest, { data: JSON.stringify(recordingPrepared) });
    assert.deepEqual(host.messages, [recordingPrepared]);

    await signaling.onMessage(host, { data: JSON.stringify(recordingState) });
    assert.deepEqual(guest.messages, [recordingPrepare, recordingState]);

    const recordingAck = {
      type: 'recording-ack',
      recording: true,
      eventId: recordingState.eventId,
      sequence: recordingState.sequence,
      generation: recordingState.generation,
      accepted: true
    };
    await signaling.onMessage(guest, { data: JSON.stringify(recordingAck) });
    assert.deepEqual(host.messages, [recordingPrepared, recordingAck]);

    await signaling.onMessage(guest, { data: JSON.stringify({ type: 'recording-state', recording: false }) });
    assert.equal(guest.readyState, 3);
    assert.equal(host.messages.some((message) => message.type === 'recording-state'), false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('relays session names from the authenticated host and rejects guest changes', async () => {
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
    signaling.authenticatedSubjects.set(host, {
      sub: 'auth0|host-session-name',
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const update = { type: 'session-name', name: 'Recording 10/08 21:52' };
    await signaling.onMessage(host, { data: JSON.stringify(update) });
    assert.deepEqual(guest.messages, [update]);

    await signaling.onMessage(guest, {
      data: JSON.stringify({ type: 'session-name', name: 'Guest override' })
    });
    assert.equal(guest.readyState, 3);
    assert.deepEqual(host.messages, [{ type: 'peer-left' }]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('rejects empty and oversized host session names', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const makeSocket = () => ({
    readyState: 1,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)); },
    close() { this.readyState = 3; }
  });
  try {
    for (const name of ['', 'x'.repeat(121)]) {
      const host = makeSocket();
      const guest = makeSocket();
      const signaling = new RoomSignaling({});
      signaling.peers.set(host, 'host');
      signaling.peers.set(guest, 'guest');
      signaling.authenticatedSubjects.set(host, {
        sub: 'auth0|host-session-name',
        exp: Math.floor(Date.now() / 1000) + 600
      });

      await signaling.onMessage(host, { data: JSON.stringify({ type: 'session-name', name }) });
      assert.equal(host.readyState, 3);
      assert.deepEqual(guest.messages, []);
    }
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
    signaling.authenticatedSubjects.set(host, {
      sub: 'auth0|host-readiness',
      exp: Math.floor(Date.now() / 1000) + 600
    });

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
    signaling.authenticatedSubjects.set(host, {
      sub: 'auth0|host-readiness',
      exp: Math.floor(Date.now() / 1000) + 600
    });
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

test('processes readiness only after an earlier asynchronous auth message completes', async () => {
  const call = Object.create(RoomCall.prototype);
  let releaseAuthentication;
  const processed = [];
  Object.assign(call, {
    incomingMessageChain: Promise.resolve(),
    async processMessage(message) {
      processed.push(`${message}:start`);
      if (message === 'auth-confirm') {
        await new Promise((resolve) => { releaseAuthentication = resolve; });
      }
      processed.push(`${message}:end`);
    }
  });

  const authMessage = call.handleMessage('auth-confirm');
  const readinessMessage = call.handleMessage('ready-state');
  await Promise.resolve();
  assert.deepEqual(processed, ['auth-confirm:start']);

  releaseAuthentication();
  await Promise.all([authMessage, readinessMessage]);
  assert.deepEqual(processed, [
    'auth-confirm:start',
    'auth-confirm:end',
    'ready-state:start',
    'ready-state:end'
  ]);
});

test('sends host session-name updates to a connected guest and applies them on the guest', async () => {
  const sent = [];
  const host = Object.create(RoomCall.prototype);
  Object.assign(host, {
    inviteMode: false,
    localRole: 'host',
    sessionName: null,
    pendingGuest: {},
    peerConnection: {},
    send(message) { sent.push(message); }
  });
  host.setSessionName('Recording 10/08 21:52');
  assert.deepEqual(sent, [{ type: 'session-name', name: 'Recording 10/08 21:52' }]);

  const received = [];
  const guest = Object.create(RoomCall.prototype);
  Object.assign(guest, {
    inviteMode: true,
    localRole: 'guest',
    remoteSessionName: null,
    onSessionName: async (name) => received.push(name)
  });
  await guest.processMessage(sent[0]);
  assert.equal(guest.remoteSessionName, 'Recording 10/08 21:52');
  assert.deepEqual(received, ['Recording 10/08 21:52']);
  guest.setSessionName('Guest override');
  assert.deepEqual(received, ['Recording 10/08 21:52']);
});

test('does not log signaling message traffic', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const sent = [];
    const events = [];
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      socket: { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
      onNetworkEvent: (event, details) => events.push({ event, details })
    });
    call.send({
      type: 'recording-state',
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 4,
      recording: true,
      startAt: 12345.5,
      clockOffsetMs: -2.25,
      secret: 'must-not-be-logged'
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(events, []);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('logs join requests sent and received without exposing guest identity', async () => {
  assert.match(
    RoomCall.prototype.requestJoin.toString(),
    /this\.prepareRecordingAudioContext\?\.\(\);[\s\S]*?await this\.getMicrophoneStream\(\)/
  );
  assert.match(
    RoomCall.prototype.requestJoin.toString(),
    /this\.send\(\{[\s\S]*?type: 'join-request'[\s\S]*?\}\);\s*this\.logNetworkEvent\('Join request sent', `issuedAt=\$\{issuedAt\}`\)/
  );

  const receivedEvents = [];
  const host = Object.create(RoomCall.prototype);
  Object.assign(host, {
    pendingGuest: {},
    peerConnection: null,
    getRecordingState: () => false,
    send() {},
    onNetworkEvent: (event, details) => receivedEvents.push({ event, details })
  });
  await host.receiveJoinRequest({ name: 'Private guest name' });
  assert.deepEqual(receivedEvents, [{ event: 'Join request received', details: '' }]);
});

test('resets remote waveform history to the local recording start time', () => {
  const canvasClears = [];
  const waveform = {
    id: 'track',
    history: new Float32Array(600).fill(0.5),
    historyCount: 12,
    lastSampleIndex: 11,
    recordingStartedAt: null,
    sampledAt: 10,
    startedAt: 5,
    rulerSecond: 10,
    animationFrame: null,
    track: { muted: false },
    canvas: {
      width: 100,
      height: 50,
      getContext: () => ({ clearRect: (...args) => canvasClears.push(args) })
    }
  };
  const call = Object.create(RoomCall.prototype);
  call.remoteWaveforms = new Map([['track', waveform]]);
  const drawn = [];
  const states = [];
  call.drawRemoteWaveform = (track) => drawn.push(track);
  call.setRemoteWaveState = (...state) => states.push(state);

  call.beginRecordingWaveform(100);
  assert.equal(call.waveformRecordingStartedAt, 100);
  assert.equal(waveform.history.some((sample) => sample !== 0), false);
  assert.equal(waveform.historyCount, 0);
  assert.equal(waveform.lastSampleIndex, -1);
  assert.equal(waveform.sampledAt, 100);
  assert.equal(waveform.startedAt, 100);
  assert.equal(waveform.rulerSecond, -1);
  assert.deepEqual(drawn, [waveform]);
  assert.deepEqual(states, [['Preparing waveform', false, 'track']]);

  call.endRecordingWaveform();
  assert.equal(call.waveformRecordingStartedAt, null);
  assert.equal(waveform.historyCount, 0);
  assert.equal(waveform.recordingStartedAt, null);
  assert.deepEqual(canvasClears, [[0, 0, 100, 50]]);
  assert.deepEqual(states.at(-1), ['Waiting to record', false, 'track']);
});

test('hides waiting labels from the remote waveform state', () => {
  const call = Object.create(RoomCall.prototype);
  const classes = new Set();
  const state = {
    textContent: '',
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    }
  };
  call.remoteWaveforms = new Map([['track', { state }]]);

  call.setRemoteWaveState('Waiting to record');
  assert.equal(state.textContent, '');
  call.setRemoteWaveState('Awaiting approval');
  assert.equal(state.textContent, '');
  call.setRemoteWaveState('LIVE', true);
  assert.equal(state.textContent, 'LIVE');
  assert.equal(classes.has('remote-live'), true);
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

test('passes the host wall-clock start timestamp to the guest recorder', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const received = [];
    const sent = [];
    const generation = '0123456789abcdefghij_-';
    const hostStartedAt = Date.now() + 5000;
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      localRole: 'guest',
      connected: true,
      localReady: true,
      remoteReady: true,
      socket: { readyState: 1 },
      peerConnection: { connectionState: 'connected' },
      authFields: { generation },
      guestRecordingCommands: new Map(),
      lastGuestRecordingSequence: 0,
      pendingGuestRecordingCommand: null,
      onRecordingState: async (_recording, schedule) => {
        received.push(schedule);
        return true;
      },
      send(message) { sent.push(message); },
      setStatus() {}
    });

    await call.receiveRecordingState({
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation,
      recording: true,
      startAt: performance.now() + 5000,
      clockOffsetMs: 20,
      hostStartedAt
    });

    assert.equal(received[0].hostStartedAt, hostStartedAt);
    assert.equal(sent[0].type, 'recording-ack');
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('confirms guest recording preparation before the host schedules the start', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = globalThis.window;
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.window = { setTimeout, clearTimeout };
  try {
    const sent = [];
    const generation = '0123456789abcdefghij_-';
    const eventId = '123e4567-e89b-42d3-a456-426614174000';
    const host = Object.create(RoomCall.prototype);
    Object.assign(host, {
      localRole: 'host',
      connected: true,
      localReady: true,
      remoteReady: true,
      socket: { readyState: 1 },
      peerConnection: { connectionState: 'connected' },
      authFields: { generation },
      pendingRecordingPreparations: new Map(),
      send(message) { sent.push(message); }
    });

    const prepared = host.prepareGuestRecording(eventId, 1);
    assert.deepEqual(sent, [{
      type: 'recording-prepare',
      eventId,
      sequence: 1,
      generation
    }]);
    host.receiveRecordingPrepared({
      type: 'recording-prepared',
      eventId,
      sequence: 1,
      generation,
      accepted: true
    });
    assert.equal(await prepared, true);

    const cancelled = host.prepareGuestRecording(
      '123e4567-e89b-42d3-a456-426614174001',
      2
    );
    host.cancelGuestRecordingPreparation('123e4567-e89b-42d3-a456-426614174001');
    assert.equal(await cancelled, false);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('prepares guest recording resources and acknowledges duplicate preparation requests', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const sent = [];
    const prepared = [];
    const generation = '0123456789abcdefghij_-';
    const message = {
      type: 'recording-prepare',
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 1,
      generation
    };
    const guest = Object.create(RoomCall.prototype);
    Object.assign(guest, {
      localRole: 'guest',
      connected: true,
      localReady: true,
      remoteReady: true,
      socket: { readyState: 1 },
      peerConnection: { connectionState: 'connected' },
      authFields: { generation },
      guestRecordingPreparations: new Map(),
      onRecordingPrepare: async (event) => {
        prepared.push(event);
        return true;
      },
      send(response) { sent.push(response); },
      setStatus() {}
    });

    await guest.receiveRecordingPrepare(message);
    await guest.receiveRecordingPrepare(message);

    assert.deepEqual(prepared, [{ eventId: message.eventId, sequence: 1 }]);
    assert.deepEqual(sent, [
      { type: 'recording-prepared', eventId: message.eventId, sequence: 1, generation, accepted: true },
      { type: 'recording-prepared', eventId: message.eventId, sequence: 1, generation, accepted: true }
    ]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('logs guest recording-start confirmation dispatch and host unmatched confirmation', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const generation = '0123456789abcdefghij_-';
    const sent = [];
    const guestEvents = [];
    const guest = Object.create(RoomCall.prototype);
    Object.assign(guest, {
      localRole: 'guest',
      authFields: { generation },
      socket: { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
      onNetworkEvent: (event, details) => guestEvents.push({ event, details })
    });
    guest.notifyRecordingStarted(
      { eventId: '123e4567-e89b-42d3-a456-426614174000', sequence: 3 },
      456.789,
      0
    );
    assert.equal(sent[0].type, 'recording-started');
    assert.deepEqual(guestEvents.map(({ event }) => event), [
      'Recording start local',
      'Recording start confirmation sent'
    ]);

    const hostEvents = [];
    const host = Object.create(RoomCall.prototype);
    Object.assign(host, {
      localRole: 'host',
      authFields: { generation },
      pendingStartEvents: new Map(),
      onNetworkEvent: (event, details) => hostEvents.push({ event, details })
    });
    host.receiveRecordingStarted({
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      sequence: 3,
      generation,
      observedAt: 456.789,
      frame: 0
    });
    assert.deepEqual(hostEvents, [{
      event: 'Recording start confirmation ignored',
      details: 'event=123e4567-e89b-42d3-a456-426614174000 no pending start event (timed out, canceled, or already completed)'
    }]);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('logs application status events without logging each transferred chunk', () => {
  const originalDocument = globalThis.document;
  const roomStatus = {
    textContent: '',
    classList: { toggle() {} }
  };
  globalThis.document = {
    getElementById: (id) => id === 'roomStatus' ? roomStatus : null
  };
  const events = [];
  const call = Object.create(RoomCall.prototype);
  call.onNetworkEvent = (event, details) => events.push({ event, details });
  try {
    call.setStatus('Both devices are ready to record.');
    call.setStatus('Both devices are ready to record.');
    call.setStatus('The guest’s recording stop and save were confirmed.');
    call.setStatus('Saved on the host device · Guest · chunk 4');
    call.setStatus('All chunks saved on the host device · Guest');

    assert.deepEqual(events, [
      { event: 'Application event', details: 'Both devices are ready to record.' },
      { event: 'Application event', details: 'The guest’s recording stop and save were confirmed.' },
      { event: 'Application event', details: 'All chunks saved on the host device · Guest' }
    ]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('renders recording readiness as a persistent accessible badge', () => {
  const originalDocument = globalThis.document;
  const classes = new Set(['off']);
  const badge = {
    textContent: 'READY',
    attributes: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };
  globalThis.document = { getElementById: (id) => id === 'recordingReadiness' ? badge : null };
  try {
    const call = Object.create(RoomCall.prototype);
    call.setReadyBadge(false);
    assert.equal(badge.textContent, 'READY');
    assert.equal(classes.has('off'), true);
    assert.equal(badge.attributes['aria-label'], 'Not ready to record');
    call.setReadyBadge(true);
    assert.equal(badge.textContent, 'READY');
    assert.equal(classes.has('on'), true);
    assert.equal(badge.attributes['aria-label'], 'Ready to record');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('logs synchronized recording stop commands when sent and received', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  try {
    const eventId = '123e4567-e89b-42d3-a456-426614174000';
    const hostEvents = [];
    const pending = {
      recording: false,
      eventId,
      sequence: 4,
      generation: 'generation',
      retries: 0,
      timer: null
    };
    const host = Object.create(RoomCall.prototype);
    Object.assign(host, {
      pendingRecordingCommands: new Map([[eventId, pending]]),
      pendingStartEvents: new Map(),
      onNetworkEvent: (event, details) => hostEvents.push({ event, details }),
      send() {},
      setStatus() {}
    });
    host.sendRecordingCommand(pending);
    window.clearTimeout(pending.timer);
    assert.deepEqual(hostEvents, [{
      event: 'Recording stop command sent',
      details: `event=${eventId} sequence=4`
    }]);

    const guestEvents = [];
    const guest = Object.create(RoomCall.prototype);
    Object.defineProperties(guest, {
      connected: { value: true },
      isPeerReadyForRecording: { value: true }
    });
    Object.assign(guest, {
      localRole: 'guest',
      authFields: { generation: 'generation' },
      guestRecordingCommands: new Map(),
      guestRecordingPreparations: new Map(),
      lastGuestRecordingSequence: 0,
      onNetworkEvent: (event, details) => guestEvents.push({ event, details }),
      applyGuestRecordingCommand: async () => {},
      sendRecordingAck() {}
    });
    await guest.receiveRecordingState({
      type: 'recording-state',
      recording: false,
      eventId,
      sequence: 4,
      generation: 'generation'
    });
    assert.deepEqual(guestEvents, [{
      event: 'Recording stop command received',
      details: `event=${eventId} sequence=4`
    }]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
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
    assert.match(call.status.message, /difference 0 ms/u);
    assert.equal(call.status.isError, false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('does not stop recording when a peer start confirmation is late', () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  let timeoutCallback;
  let stopCount = 0;
  let status = '';
  globalThis.window = {
    setTimeout(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout() {}
  };
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const call = Object.create(RoomCall.prototype);
    Object.assign(call, {
      localRole: 'host',
      connected: true,
      localReady: true,
      remoteReady: true,
      socket: { readyState: 1 },
      peerConnection: { connectionState: 'connected' },
      authFields: { generation: '0123456789abcdefghij_-' },
      recordingSequence: 0,
      pendingRecordingCommands: new Map(),
      pendingStartEvents: new Map(),
      getRecordingState: () => true,
      onRecordingState: () => { stopCount += 1; },
      cancelPendingTurnCredentials() {},
      clearPendingStartEvents() {},
      sendRecordingCommand() {},
      setStatus(message) { status = message; }
    });

    call.setHostRecordingState(
      true,
      performance.now() + 5000,
      0,
      '123e4567-e89b-42d3-a456-426614174000'
    );
    timeoutCallback();

    assert.equal(stopCount, 0);
    assert.match(status, /Recording continues/u);
    assert.equal(call.pendingStartEvents.size, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
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

test('accepts only matching host TURN responses and installs relayed credentials for both roles', async () => {
  const originalWindow = globalThis.window;
  const originalRTCPeerConnection = globalThis.RTCPeerConnection;
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const iceServers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'short-lived-user',
      credential: 'short-lived-password'
    }
  ];
  const connectionConfigurations = [];
  class MockRTCPeerConnection {
    constructor(configuration) {
      connectionConfigurations.push(configuration);
    }

    addEventListener() {}

    createDataChannel(label, options) {
      return { label, readyState: 'connecting', bufferedAmount: 0, addEventListener() {}, ...options };
    }
  }
  globalThis.window = {
    RTCPeerConnection: MockRTCPeerConnection,
    clearTimeout() {}
  };
  globalThis.RTCPeerConnection = MockRTCPeerConnection;

  try {
    const host = Object.create(RoomCall.prototype);
    let resolvedCredentials = null;
    const pending = {
      requestId,
      timer: 1,
      resolve(value) { resolvedCredentials = value; },
      reject() {}
    };
    Object.assign(host, {
      localRole: 'host',
      pendingTurnCredentials: pending,
      turnIceServers: null,
      recordingTransfer: { setRole() {}, setChannel() {} }
    });

    test('validates and applies bounded remote microphone monitor updates', () => {
      const call = Object.create(RoomCall.prototype);
      const errors = [];
      call.remoteWaveforms = new Map();
      call.setStatus = (message, isError) => errors.push({ message, isError });
      call.updateRemoteInputMonitor = (state) => { call.remoteInputMonitorState = state; };

      call.receiveInputMonitorMessage(JSON.stringify({
        type: 'input-state',
        level: 0.42,
        muted: false,
        deviceLabel: 'USB Microphone'
      }));
      assert.deepEqual(call.remoteInputMonitorState, {
        level: 0.42,
        muted: false,
        deviceLabel: 'USB Microphone'
      });

      call.receiveInputMonitorMessage(JSON.stringify({
        type: 'input-state',
        level: 2,
        muted: false,
        deviceLabel: 'invalid'
      }));
      assert.equal(errors.at(-1).isError, true);
    });

    test('sends mute changes immediately instead of rate-limiting them with meter updates', () => {
      const messages = [];
      const call = Object.create(RoomCall.prototype);
      Object.assign(call, {
        inputMonitorChannel: {
          readyState: 'open',
          bufferedAmount: 0,
          send(message) { messages.push(JSON.parse(message)); }
        },
        lastInputMonitorSentAt: -Infinity,
        lastInputMonitorSentState: null,
        localInputMonitorState: { level: 0.5, muted: false, deviceLabel: '' }
      });

      call.sendInputMonitorState(0.5, false, 'USB Microphone');
      call.lastInputMonitorSentAt = performance.now();
      call.sendInputMonitorState(0, true, 'USB Microphone');

      assert.equal(messages.length, 2);
      assert.equal(messages[1].muted, true);
    });

    test('renders the other participant microphone name in the read-only selector', () => {
      const call = Object.create(RoomCall.prototype);
      const option = { textContent: 'Waiting for information' };
      const muteClasses = new Set();
      const muteState = {
        textContent: '',
        classList: {
          toggle(name, enabled) {
            if (enabled) muteClasses.add(name);
            else muteClasses.delete(name);
          }
        },
        setAttribute(name, value) {
          this[name] = value;
        }
      };
      const waveform = {
        meterFill: { style: {}, className: '' },
        meter: { setAttribute(name, value) { this[name] = value; } },
        device: { options: [option] },
        muteState
      };
      call.remoteWaveforms = new Map([['track', waveform]]);

      call.updateRemoteInputMonitor({ level: 0, muted: null, deviceLabel: '' });
      assert.equal(muteState.textContent, '');

      call.updateRemoteInputMonitor({ level: 0.5, muted: true, deviceLabel: 'USB Microphone' });
      assert.equal(option.textContent, 'USB Microphone · MUTE');
      assert.equal(muteState.textContent, 'MUTED');
      assert.equal(muteState['aria-label'], 'The other participant is muted');
      assert.equal(muteClasses.has('muted'), true);
      assert.equal(waveform.meter['aria-valuenow'], '0');
      assert.equal(waveform.meterFill.style.height, '0%');

      call.updateRemoteInputMonitor({ level: 0.5, muted: false, deviceLabel: 'USB Microphone' });
      assert.equal(muteState.textContent, 'UNMUTED');
      assert.equal(muteState['aria-label'], 'The other participant is not muted');
      assert.equal(muteClasses.has('muted'), false);
      assert.equal(muteClasses.has('unmuted'), true);
    });

    host.receiveTurnCredentials({
      requestId: '223e4567-e89b-42d3-a456-426614174001',
      iceServers
    });
    assert.equal(host.turnIceServers, null);
    assert.equal(host.pendingTurnCredentials, pending);

    host.receiveTurnCredentials({ requestId, iceServers });
    assert.deepEqual(resolvedCredentials, iceServers);
    assert.deepEqual(host.turnIceServers, iceServers);
    assert.equal(host.pendingTurnCredentials, null);

    const guest = Object.create(RoomCall.prototype);
    Object.assign(guest, {
      localRole: 'guest',
      pendingTurnCredentials: null,
      turnIceServers: null,
      recordingTransfer: { setRole() {}, setChannel() {} }
    });
    guest.receiveTurnCredentials({ requestId, iceServers });
    assert.deepEqual(guest.turnIceServers, iceServers);

    await host.createPeerConnection();
    await guest.createPeerConnection();
    assert.deepEqual(connectionConfigurations.slice(0, 2), [
      { iceServers },
      { iceServers }
    ]);

    const fallbackHost = Object.create(RoomCall.prototype);
    Object.assign(fallbackHost, {
      localRole: 'host',
      turnIceServers: null,
      recordingTransfer: { setRole() {}, setChannel() {} }
    });
    await fallbackHost.createPeerConnection();
    assert.deepEqual(connectionConfigurations[2], {
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalRTCPeerConnection === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = originalRTCPeerConnection;
  }
});

test('issues short-lived TURN credentials only for an authenticated host after guest approval', async () => {
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
  globalThis.fetch = async (url, init) => {
    fetchCount += 1;
    assert.match(String(url), /rtc\.live\.cloudflare\.com\/v1\/turn\/keys\/test-key\/credentials/u);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(init.body).ttl, 10_800);
    return Response.json({ iceServers: [{
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'short-lived-user',
      credential: 'short-lived-password'
    }] });
  };
  try {
    const unauthorized = new RoomSignaling({}, { TURN_API_TOKEN: 'test-token', TURN_KEY_ID: 'test-key' });
    const deniedHost = makeSocket();
    unauthorized.peers.set(deniedHost, 'host');
    unauthorized.turnRateLimitConfigured = true;
    await unauthorized.onMessage(deniedHost, {
      data: JSON.stringify({ type: 'turn-request', requestId: '123e4567-e89b-42d3-a456-426614174000' })
    });
    assert.equal(deniedHost.readyState, 3);
    assert.equal(fetchCount, 0);

    const host = makeSocket();
    const guest = makeSocket();
    const signaling = new RoomSignaling({}, {
      TURN_API_TOKEN: 'test-token',
      TURN_KEY_ID: 'test-key'
    });
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    signaling.authenticatedSubjects.set(host, { sub: 'auth0|host-1', exp: Math.floor(Date.now() / 1000) + 600 });
    signaling.roomId = 'A'.repeat(43);
    signaling.turnRateLimitConfigured = true;
    await signaling.onMessage(host, { data: JSON.stringify({ type: 'approved' }) });
    const requestId = '223e4567-e89b-42d3-a456-426614174001';
    await signaling.onMessage(host, { data: JSON.stringify({ type: 'turn-request', requestId }) });
    assert.equal(fetchCount, 1);
    assert.deepEqual(host.messages.at(-1), {
      type: 'turn-credentials',
      requestId,
      iceServers: [{
        urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'short-lived-user',
        credential: 'short-lived-password'
      }]
    });
    assert.deepEqual(guest.messages.at(-1), host.messages.at(-1));
    await signaling.onMessage(host, {
      data: JSON.stringify({ type: 'turn-request', requestId: '323e4567-e89b-42d3-a456-426614174002' })
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
  const host = { readyState: 1, messages: [], send(message) { this.messages.push(JSON.parse(message)); }, close() { this.readyState = 3; } };
  const guest = { readyState: 1, messages: [], send(message) { this.messages.push(JSON.parse(message)); }, close() { this.readyState = 3; } };
  try {
    const signaling = new RoomSignaling({});
    signaling.peers.set(host, 'host');
    signaling.peers.set(guest, 'guest');
    signaling.authenticatedSubjects.set(host, { sub: 'auth0|host-2', exp: Math.floor(Date.now() / 1000) + 600 });
    signaling.roomId = 'B'.repeat(43);
    signaling.turnRateLimitConfigured = true;
    await signaling.onMessage(host, { data: JSON.stringify({ type: 'approved' }) });
    await signaling.onMessage(host, {
      data: JSON.stringify({ type: 'turn-request', requestId: '123e4567-e89b-42d3-a456-426614174000' })
    });
    assert.equal(host.messages.at(-1).type, 'turn-error');
    assert.deepEqual(guest.messages.at(-1), host.messages.at(-1));
    assert.match(host.messages.at(-1).message, /not configured/u);
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

test('requires Auth0 host authentication before issuing TURN test credentials', async () => {
  const roomId = 'G'.repeat(43);
  const response = await worker.fetch(new Request('https://pod.test/turn-test/credentials', {
    method: 'POST',
    headers: {
      Origin: 'https://pod.test',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.60'
    },
    body: JSON.stringify({ roomId })
  }), {
    SIGNAL_RATE_LIMITER: { async limit() { return { success: true }; } },
    ROOMS: { getByName() { assert.fail('Unauthenticated requests must not reach the room object.'); } }
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).message, /Log in/u);
});

test('rejects cross-origin TURN test credential requests', async () => {
  const response = await worker.fetch(new Request('https://pod.test/turn-test/credentials', {
    method: 'POST',
    headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: 'H'.repeat(43) })
  }), {});
  assert.equal(response.status, 403);
});
