import { open, chmod } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';

const [privateKeyPath] = process.argv.slice(2);
if (!privateKeyPath) {
  console.error('Usage: node scripts/create-turn-permit-keypair.js <private-key-file>');
  process.exitCode = 2;
} else {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateFile = await open(privateKeyPath, 'wx', 0o600);
  try {
    await privateFile.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  } finally {
    await privateFile.close();
  }
  await chmod(privateKeyPath, 0o600);
  process.stdout.write(`${publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}\n`);
}
