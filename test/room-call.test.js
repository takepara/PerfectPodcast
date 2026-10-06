import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintFromSdp, invitationProof, transcript } from '../prototype/room-call.js';
import { RoomSignaling } from '../worker/index.js';

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
      sequence: 1
    };
    await signaling.onMessage(host, { data: JSON.stringify(recordingState) });
    assert.deepEqual(guest.messages, [recordingState]);

    const recordingAck = {
      type: 'recording-ack',
      recording: true,
      eventId: recordingState.eventId,
      sequence: recordingState.sequence,
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
      sequence: 1
    }) });
    assert.equal(host.readyState, 3);
    assert.equal(guest.messages.length, 0);
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
