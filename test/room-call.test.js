import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintFromSdp, invitationProof, transcript } from '../prototype/room-call.js';

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
