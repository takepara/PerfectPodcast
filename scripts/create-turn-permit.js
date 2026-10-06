import { readFile } from 'node:fs/promises';
import { createPrivateKey, createHash, randomBytes, sign } from 'node:crypto';
import { turnPermitSigningMessage } from '../shared/turn-permit.js';

const [roomId, hostPublicKey] = process.argv.slice(2);
const privateKeyPath = process.env.TURN_PERMIT_PRIVATE_KEY_PATH;
if (!/^[A-Za-z0-9_-]{43}$/u.test(roomId || '') ||
    typeof hostPublicKey !== 'string' || !/^[A-Za-z0-9_-]{80,256}$/u.test(hostPublicKey) ||
    !privateKeyPath) {
  console.error(
    'Usage: TURN_PERMIT_PRIVATE_KEY_PATH=/secure/turn-permit.pem node scripts/create-turn-permit.js <room-id> <host-public-key>'
  );
  process.exitCode = 2;
} else {
  const hostKeyBytes = Buffer.from(hostPublicKey, 'base64url');
  if (hostKeyBytes.length < 64 || hostKeyBytes.length > 192) {
    throw new Error('Host public key is not a valid bounded base64url value.');
  }
  const issuedAt = Date.now();
  const payload = {
    v: 1,
    roomId,
    hostKeyHash: createHash('sha256').update(hostKeyBytes).digest('base64url'),
    issuedAt,
    expiresAt: issuedAt + 3 * 60 * 60 * 1000,
    jti: randomBytes(16).toString('base64url'),
    maxGuests: 1
  };
  const signingKey = createPrivateKey(await readFile(privateKeyPath));
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(turnPermitSigningMessage(payload)), signingKey)
    .toString('base64url');
  process.stdout.write(`${payloadPart}.${signature}\n`);
}
