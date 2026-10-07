import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker, { RoomSignaling } from '../worker/index.js';

const issuer = 'https://perfectpodcast-test.auth0.com/';
const audience = 'https://perfectpodcast-api.test';
const hostPermission = 'recording:host';
const roomId = 'A'.repeat(43);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
Object.assign(jwk, { kid: 'auth0-test-key', use: 'sig', alg: 'RS256' });

const env = {
  AUTH0_DOMAIN: 'perfectpodcast-test.auth0.com',
  AUTH0_CLIENT_ID: 'test-client-id',
  AUTH0_AUDIENCE: audience,
  AUTH0_HOST_PERMISSION: hostPermission
};

async function makeToken(scope = hostPermission, overrides = {}) {
  return new SignJWT({ scope, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('auth0|host-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function mockJwksFetch(originalFetch) {
  return async (input, init) => {
    if (String(input) === `${issuer}.well-known/jwks.json`) {
      return Response.json({ keys: [jwk] });
    }
    return originalFetch(input, init);
  };
}

test('publishes only public Auth0 SPA settings and creates an HttpOnly host session', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockJwksFetch(originalFetch);
  try {
    const configResponse = await worker.fetch(new Request('https://pod.test/auth/config'), env);
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), {
      domain: env.AUTH0_DOMAIN,
      clientId: env.AUTH0_CLIENT_ID,
      audience,
      hostPermission
    });

    const token = await makeToken();
    const sessionResponse = await worker.fetch(new Request('https://pod.test/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://pod.test',
        Authorization: `Bearer ${token}`
      }
    }), env);
    assert.equal(sessionResponse.status, 200);
    const cookie = sessionResponse.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-perfectpodcast-host=/u);
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /Secure/u);
    assert.match(cookie, /SameSite=Strict/u);
    assert.equal(sessionResponse.headers.get('Cache-Control'), 'no-store');

    const sessionCheck = await worker.fetch(new Request('https://pod.test/auth/session', {
      headers: { Cookie: cookie.split(';', 1)[0] }
    }), env);
    assert.equal(sessionCheck.status, 200);
    assert.equal((await sessionCheck.json()).sub, 'auth0|host-user');

    const logout = await worker.fetch(new Request('https://pod.test/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://pod.test' }
    }), env);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requires the Auth0 host permission and rejects forged or cross-origin sessions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockJwksFetch(originalFetch);
  try {
    const unauthorizedToken = await makeToken('openid profile');
    const unauthorizedResponse = await worker.fetch(new Request('https://pod.test/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://pod.test',
        Authorization: `Bearer ${unauthorizedToken}`
      }
    }), env);
    assert.equal(unauthorizedResponse.status, 403);

    const forgedResponse = await worker.fetch(new Request('https://pod.test/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://pod.test',
        Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHxob3N0In0.invalid'
      }
    }), env);
    assert.equal(forgedResponse.status, 401);

    const crossOriginResponse = await worker.fetch(new Request('https://pod.test/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.test',
        Authorization: `Bearer ${await makeToken()}`
      }
    }), env);
    assert.equal(crossOriginResponse.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('passes only verified Auth0 identity to the signaling object', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockJwksFetch(originalFetch);
  const token = await makeToken();
  const keys = [];
  const envWithSignaling = {
    ...env,
    SIGNAL_RATE_LIMITER: { async limit({ key }) { keys.push(key); return { success: true }; } },
    ROOMS: {
      getByName(name) {
        assert.equal(name, roomId);
        return {
          async fetch(request) {
            assert.equal(request.headers.get('x-auth0-sub'), 'auth0|host-user');
            assert.ok(Number(request.headers.get('x-auth0-exp')) > Math.floor(Date.now() / 1000));
            assert.equal(request.headers.has('Cookie'), false);
            assert.equal(request.headers.has('Authorization'), false);
            return new Response('forwarded');
          }
        };
      }
    }
  };
  try {
    const response = await worker.fetch(new Request(`https://pod.test/signal/${roomId}`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: `__Host-perfectpodcast-host=${token}`,
        'CF-Connecting-IP': '192.0.2.80'
      }
    }), envWithSignaling);
    assert.equal(await response.text(), 'forwarded');
    assert.deepEqual(keys, ['192.0.2.80']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('allows anonymous guests but rejects unauthenticated host roles', () => {
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
    signaling.authenticatedSubjects.set(host, null);
    signaling.authenticatedSubjects.set(guest, null);
    signaling.join(host, { type: 'join', role: 'host' });
    assert.equal(host.readyState, 3);

    const authenticatedHost = makeSocket();
    signaling.authenticatedSubjects.set(authenticatedHost, {
      sub: 'auth0|host-user',
      exp: Math.floor(Date.now() / 1000) + 600
    });
    signaling.join(authenticatedHost, { type: 'join', role: 'host' });
    assert.equal(authenticatedHost.messages.at(-1).type, 'joined');
    signaling.join(guest, { type: 'join', role: 'guest' });
    assert.equal(guest.messages.at(-1).type, 'joined');
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
  }
});

test('requires Auth0 host authentication before issuing TURN test credentials', async () => {
  const response = await worker.fetch(new Request('https://pod.test/turn-test/credentials', {
    method: 'POST',
    headers: {
      Origin: 'https://pod.test',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.81'
    },
    body: JSON.stringify({ roomId })
  }), {
    ...env,
    SIGNAL_RATE_LIMITER: { async limit() { return { success: true }; } },
    ROOMS: { getByName() { assert.fail('Unauthenticated request reached a room.'); } }
  });
  assert.equal(response.status, 401);
});

test('returns short-lived TURN credentials only to an Auth0-authorized host', async () => {
  const originalFetch = globalThis.fetch;
  const token = await makeToken();
  let providerRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === `${issuer}.well-known/jwks.json`) {
      return Response.json({ keys: [jwk] });
    }
    providerRequests += 1;
    assert.match(String(input), /rtc\.live\.cloudflare\.com\/v1\/turn\/keys\/test-key\/credentials/u);
    assert.equal(init.headers.Authorization, 'Bearer test-turn-api-token');
    return Response.json({ iceServers: [{
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'short-lived',
      credential: 'short-lived-secret'
    }] });
  };
  try {
    const sessionResponse = await worker.fetch(new Request('https://pod.test/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://pod.test',
        Authorization: `Bearer ${token}`
      }
    }), env);
    const cookie = sessionResponse.headers.get('Set-Cookie').split(';', 1)[0];
    const room = new RoomSignaling({}, {
      TURN_API_TOKEN: 'test-turn-api-token',
      TURN_KEY_ID: 'test-key'
    });
    const response = await worker.fetch(new Request('https://pod.test/turn-test/credentials', {
      method: 'POST',
      headers: {
        Origin: 'https://pod.test',
        'Content-Type': 'application/json',
        Cookie: cookie,
        'CF-Connecting-IP': '192.0.2.82'
      },
      body: JSON.stringify({ roomId })
    }), {
      ...env,
      SIGNAL_RATE_LIMITER: { async limit() { return { success: true }; } },
      TURN_API_TOKEN: 'test-turn-api-token',
      TURN_KEY_ID: 'test-key',
      ROOMS: { getByName(name) { assert.equal(name, roomId); return room; } }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { iceServers: [{
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'short-lived',
      credential: 'short-lived-secret'
    }] });
    assert.equal(providerRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
