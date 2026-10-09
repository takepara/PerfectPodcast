import { createRemoteJWKSet, jwtVerify } from 'jose';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_COOKIE = '__Host-perfectpodcast-host';
const MAX_MESSAGE_BYTES = 64 * 1024;
const ALLOWED_MESSAGES = {
  host: new Set(['approved', 'denied', 'offer', 'auth-confirm', 'candidate', 'ice-restart', 'recording-state', 'recording-prepare', 'ready-state', 'clock-ping', 'turn-request', 'session-name']),
  guest: new Set(['join-request', 'answer', 'candidate', 'ice-restart-answer', 'recording-ack', 'recording-prepared', 'ready-state', 'clock-pong', 'recording-started', 'transfer-progress'])
};
const RECORDING_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TURN_REQUEST_ID_PATTERN = RECORDING_EVENT_ID_PATTERN;
const TURN_TEST_REQUEST_MAX_BYTES = 8 * 1024;
const MAX_TRANSFER_FRAMES = 2 * 60 * 60 * 48_000;
const MAX_TRANSFER_TAKES = 1_000_000;
const MAX_TRANSFER_BYTES = MAX_TRANSFER_FRAMES * 3 + MAX_TRANSFER_TAKES * 44;
const TURN_TTL_DEFAULT_SECONDS = 10_800;
const TURN_TTL_MAX_SECONDS = 172_800;
const AUTH0_JWKS = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) return handleAuthRequest(request, env, url);
    if (url.pathname === '/turn-test/credentials') {
      const errorResponse = (message, status) => Response.json({ message }, {
        status,
        headers: { 'Cache-Control': 'no-store' }
      });
      if (request.method !== 'POST') {
        return errorResponse('This request method is not allowed.', 405);
      }
      if (request.headers.get('Origin') !== url.origin) {
        return errorResponse('This origin is not allowed.', 403);
      }
      let authSession;
      try {
        authSession = await readAuthSession(request, env);
      } catch (error) {
        console.error('Auth0 token verification is unavailable.', error.code || error.name);
        return errorResponse('Unable to verify Auth0 authentication. Check your configuration and connection.', error.status || 503);
      }
      if (!authSession) return errorResponse('Log in as the host.', 401);
      if (!hasHostPermission(authSession, env)) {
        return errorResponse('This account does not have recording host permissions.', 403);
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type') || '')) {
        return errorResponse('A JSON request is required.', 415);
      }
      if (!env.SIGNAL_RATE_LIMITER) {
        return errorResponse('The TURN credential rate limiting binding is missing.', 503);
      }
      const { success } = await env.SIGNAL_RATE_LIMITER.limit({
        key: `turn-test:${request.headers.get('CF-Connecting-IP') || 'unknown'}`
      });
      if (!success) return errorResponse('Too many TURN test requests.', 429);

      const body = await readLimitedText(request, TURN_TEST_REQUEST_MAX_BYTES);
      if (body === null) return errorResponse('The request body is too large.', 413);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return errorResponse('Invalid JSON.', 400);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          !ROOM_ID_PATTERN.test(payload.roomId || '')) {
        return errorResponse('Invalid TURN test request format.', 400);
      }
      const room = env.ROOMS.getByName(payload.roomId);
      return room.fetch(new Request(`https://room/turn-test/credentials/${payload.roomId}`, {
        method: 'POST',
        headers: {
          'x-turn-test-rate-limit-configured': 'true',
          'x-auth0-sub': authSession.sub
        },
        body: JSON.stringify({ roomId: payload.roomId })
      }));
    }
    if (url.pathname.startsWith('/signal/')) {
      const roomId = url.pathname.slice('/signal/'.length);
      if (request.method !== 'GET' || !ROOM_ID_PATTERN.test(roomId) ||
          request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Not found', { status: 404 });
      }
      let rateLimitConfigured = false;
      if (env.SIGNAL_RATE_LIMITER) {
        const { success } = await env.SIGNAL_RATE_LIMITER.limit({
          key: request.headers.get('CF-Connecting-IP') || 'unknown'
        });
        if (!success) return new Response('Too many signaling connections', { status: 429 });
        rateLimitConfigured = true;
      }
      let hostAuth = null;
      const hostToken = readCookie(request.headers.get('Cookie'), AUTH_COOKIE);
      if (hostToken) {
        try {
          const authSession = await verifyAuth0AccessToken(hostToken, env);
          if (hasHostPermission(authSession, env)) {
            hostAuth = { sub: authSession.sub, exp: authSession.exp };
          }
        } catch (error) {
          if (!isInvalidAuthToken(error)) {
            console.error('Auth0 token verification is unavailable.', error.code || error.name);
            return new Response('Host authentication is temporarily unavailable.', { status: 503 });
          }
        }
      }
      const room = env.ROOMS.getByName(roomId);
      const headers = new Headers(request.headers);
      headers.set('x-signal-rate-limit-configured', String(rateLimitConfigured));
      headers.set('x-auth0-sub', hostAuth?.sub || '');
      headers.set('x-auth0-exp', hostAuth?.exp ? String(hostAuth.exp) : '');
      headers.delete('Authorization');
      headers.delete('Cookie');
      return room.fetch(new Request(request, { headers }));
    }
    return env.ASSETS.fetch(request);
  }
};

function getAuth0Config(env) {
  const domain = typeof env.AUTH0_DOMAIN === 'string'
    ? env.AUTH0_DOMAIN.trim().replace(/^https?:\/\//u, '').replace(/\/+$/u, '')
    : '';
  const clientId = env.AUTH0_CLIENT_ID;
  const audience = env.AUTH0_AUDIENCE;
  const hostPermission = env.AUTH0_HOST_PERMISSION;
  if (!/^[A-Za-z0-9.-]+$/u.test(domain) ||
      typeof clientId !== 'string' || !clientId ||
      typeof audience !== 'string' || !audience ||
      typeof hostPermission !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(hostPermission)) {
    throw Object.assign(new Error('The Auth0 domain, client ID, API audience, or host permission is not configured.'), {
      status: 503
    });
  }
  return {
    domain,
    clientId,
    audience,
    hostPermission,
    issuer: `https://${domain}/`
  };
}

async function handleAuthRequest(request, env, url) {
  const json = (payload, status = 200, headers = {}) => Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
  if (url.pathname === '/auth/config') {
    if (request.method !== 'GET') return json({ message: 'This request method is not allowed.' }, 405);
    try {
      const { domain, clientId, audience, hostPermission } = getAuth0Config(env);
      return json({ domain, clientId, audience, hostPermission });
    } catch (error) {
      return json({ message: error.message }, error.status || 503);
    }
  }
  if (url.pathname === '/auth/session' && request.method === 'GET') {
    try {
      const session = await readAuthSession(request, env);
      if (!session) return json({ message: 'Please log in.' }, 401);
      if (!hasHostPermission(session, env)) {
        return json({ message: 'This account does not have recording host permissions.' }, 403);
      }
      return json({ sub: session.sub, expiresAt: session.exp });
    } catch (error) {
      return authErrorResponse(error, json);
    }
  }
  if ((url.pathname === '/auth/session' || url.pathname === '/auth/logout') &&
      request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) {
      return json({ message: 'This origin is not allowed.' }, 403);
    }
    if (url.pathname === '/auth/logout') {
      return json({ loggedOut: true }, 200, {
        'Set-Cookie': `${AUTH_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
      });
    }
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/u)?.[1];
    if (!token) return json({ message: 'An Auth0 access token is required.' }, 401);
    try {
      const session = await verifyAuth0AccessToken(token, env);
      if (!hasHostPermission(session, env)) {
        return json({ message: 'This account does not have recording host permissions.' }, 403);
      }
      const maxAge = Math.max(0, Math.min(86_400, session.exp - Math.floor(Date.now() / 1000)));
      if (maxAge === 0) return json({ message: 'The Auth0 access token has expired.' }, 401);
      return json({ sub: session.sub, expiresAt: session.exp }, 200, {
        'Set-Cookie': `${AUTH_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
      });
    } catch (error) {
      return authErrorResponse(error, json);
    }
  }
  return json({ message: 'Not found' }, 404);
}

function authErrorResponse(error, json) {
  if (isInvalidAuthToken(error)) {
    return json({ message: 'The Auth0 access token is invalid or expired.' }, 401);
  }
  console.error('Auth0 token verification failed.', error.code || error.name);
  return json({ message: 'Unable to verify Auth0 authentication. Check your configuration and connection.' }, error.status || 503);
}

async function verifyAuth0AccessToken(token, env) {
  const { issuer, audience } = getAuth0Config(env);
  let jwks = AUTH0_JWKS.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer));
    AUTH0_JWKS.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience,
    algorithms: ['RS256'],
    clockTolerance: 5,
    requiredClaims: ['exp', 'sub']
  });
  if (typeof payload.sub !== 'string' || !payload.sub || !Number.isSafeInteger(payload.exp)) {
    throw Object.assign(new Error('The Auth0 access token is missing the sub claim.'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  }
  return payload;
}

function hasHostPermission(session, env) {
  const { hostPermission } = getAuth0Config(env);
  const scopes = typeof session.scope === 'string' ? session.scope.split(/\s+/u) : [];
  const permissions = Array.isArray(session.permissions) ? session.permissions : [];
  return scopes.includes(hostPermission) || permissions.includes(hostPermission);
}

function isInvalidAuthToken(error) {
  return typeof error?.code === 'string' &&
    (error.code.startsWith('ERR_JWT_') ||
     error.code.startsWith('ERR_JWS_') ||
     error.code === 'ERR_JWKS_NO_MATCHING_KEY');
}

async function readAuthSession(request, env) {
  const token = readCookie(request.headers.get('Cookie'), AUTH_COOKIE);
  if (!token) return null;
  try {
    return await verifyAuth0AccessToken(token, env);
  } catch (error) {
    if (isInvalidAuthToken(error)) return null;
    throw error;
  }
}

function readCookie(header, cookieName) {
  for (const part of (header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export class RoomSignaling {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.peers = new Map();
    this.authenticatedSubjects = new WeakMap();
    this.approvedGuest = false;
    this.turnCredentials = null;
    this.turnCredentialsKey = null;
    this.hostSubject = null;
    this.roomId = null;
    this.turnRateLimitConfigured = false;
    this.lastTurnAttemptAt = 0;
    this.lastTransferProgressAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const turnTestRoomMatch = url.pathname.match(/^\/turn-test\/credentials\/([^/]+)$/u);
    if (turnTestRoomMatch) return this.fetchTurnTestCredentials(request, turnTestRoomMatch[1]);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
      return new Response('Forbidden', { status: 403 });
    }
    const roomId = url.pathname.slice('/signal/'.length);
    if (!ROOM_ID_PATTERN.test(roomId)) return new Response('Not found', { status: 404 });
    this.roomId = roomId;
    this.turnRateLimitConfigured = request.headers.get('x-signal-rate-limit-configured') === 'true';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const authSub = request.headers.get('x-auth0-sub');
    const authExp = Number(request.headers.get('x-auth0-exp'));
    this.authenticatedSubjects.set(server, authSub && Number.isSafeInteger(authExp)
      ? { sub: authSub, exp: authExp }
      : null);
    server.addEventListener('message', (event) => { void this.onMessage(server, event); });
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetchTurnTestCredentials(request, roomId) {
    const json = (payload, status = 200) => Response.json(payload, {
      status,
      headers: { 'Cache-Control': 'no-store' }
    });
    if (request.method !== 'POST' || !ROOM_ID_PATTERN.test(roomId) ||
        request.headers.get('x-turn-test-rate-limit-configured') !== 'true' ||
        !request.headers.get('x-auth0-sub')) {
      return json({ message: 'TURN test requests are not allowed.' }, 403);
    }
    const body = await readLimitedText(request, TURN_TEST_REQUEST_MAX_BYTES);
    if (body === null) return json({ message: 'The request body is too large.' }, 413);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ message: 'Invalid JSON.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.roomId !== roomId) {
      return json({ message: 'Invalid TURN test request format.' }, 400);
    }
    this.roomId = roomId;
    this.turnRateLimitConfigured = true;
    try {
      const credentials = await this.getTurnCredentials(`turn-test:${roomId}`);
      return json({ iceServers: credentials.iceServers });
    } catch (error) {
      return json({ message: `Unable to issue TURN credentials: ${error.message}` }, error.status || 502);
    }
  }

  async onMessage(socket, event) {
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_MESSAGE_BYTES) {
      this.reject(socket, 'The message is too large or has an invalid format.');
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.reject(socket, 'Invalid message format.');
      return;
    }
    if (!this.peers.has(socket)) {
      this.join(socket, message);
      return;
    }
    const role = this.peers.get(socket);
    const authSession = this.authenticatedSubjects.get(socket);
    if (role === 'host' &&
        (!authSession || authSession.exp <= Math.floor(Date.now() / 1000)) &&
        !(message?.type === 'recording-state' && message.recording === false)) {
      this.reject(socket, 'The host session has expired. Please log in again.');
      return;
    }
    if (!message || typeof message.type !== 'string' || !ALLOWED_MESSAGES[role].has(message.type)) {
      this.reject(socket, 'This signaling message is not allowed.');
      return;
    }
    if (message.type === 'approved' && role !== 'host') {
      this.reject(socket, 'Only the host can approve a participant.');
      return;
    }
    if (message.type === 'denied' && role !== 'host') {
      this.reject(socket, 'Only the host can decline a join request.');
      return;
    }
    if (message.type === 'session-name' &&
        (role !== 'host' || typeof message.name !== 'string' ||
         !message.name.trim() || message.name.trim().length > 120)) {
      this.reject(socket, 'Only the host can send a valid session name.');
      return;
    }
    if (message.type === 'turn-request') {
      if (role !== 'host' || !this.authenticatedSubjects.get(socket)?.sub ||
          !TURN_REQUEST_ID_PATTERN.test(message.requestId || '')) {
        this.reject(socket, 'Only an authenticated host can request TURN credentials.');
        return;
      }
      if (!this.approvedGuest || ![...this.peers.values()].includes('guest')) {
        this.reject(socket, 'TURN credentials cannot be issued before the guest is approved.');
        return;
      }
      await this.issueTurnCredentials(socket, message.requestId);
      return;
    }
    if (message.type === 'approved') this.approvedGuest = true;
    if (message.type === 'denied') this.approvedGuest = false;
    if (['recording-state', 'recording-ack', 'recording-prepare', 'recording-prepared'].includes(message.type)) {
      if (!RECORDING_EVENT_ID_PATTERN.test(message.eventId || '') ||
          !GENERATION_PATTERN.test(message.generation || '') ||
          !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
          (['recording-state', 'recording-ack'].includes(message.type) &&
           typeof message.recording !== 'boolean') ||
          (['recording-ack', 'recording-prepared'].includes(message.type) &&
           typeof message.accepted !== 'boolean')) {
        this.reject(socket, 'Invalid recording status or acknowledgment format.');
        return;
      }
    }
    if (message.type === 'recording-state' && message.recording &&
        (!Number.isFinite(message.startAt) || message.startAt <= 0 ||
         !Number.isFinite(message.clockOffsetMs) || Math.abs(message.clockOffsetMs) > 60_000 ||
         !Number.isFinite(message.startAt + message.clockOffsetMs) ||
         (message.hostStartedAt !== undefined &&
          (!Number.isFinite(message.hostStartedAt) || message.hostStartedAt <= 0)))) {
      this.reject(socket, 'Invalid recording start time format.');
      return;
    }
    if (['recording-state', 'recording-prepare'].includes(message.type) && role !== 'host') {
      this.reject(socket, 'Only the host can send recording commands.');
      return;
    }
    if (message.type === 'ready-state' &&
        (typeof message.ready !== 'boolean' ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isSafeInteger(message.sequence) || message.sequence < 1)) {
      this.reject(socket, 'Invalid recording readiness format.');
      return;
    }
    if (message.type === 'clock-ping' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.probeId || '') ||
         !GENERATION_PATTERN.test(message.generation || '') || !Number.isFinite(message.sentAt))) {
      this.reject(socket, 'Invalid clock synchronization request format.');
      return;
    }
    if (message.type === 'clock-pong' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.probeId || '') ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isFinite(message.sentAt) || !Number.isFinite(message.receivedAt) ||
         !Number.isFinite(message.repliedAt))) {
      this.reject(socket, 'Invalid clock synchronization response format.');
      return;
    }
    if (message.type === 'recording-started' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.eventId || '') ||
         !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isFinite(message.observedAt) || message.frame !== 0)) {
      this.reject(socket, 'Invalid recording start confirmation format.');
      return;
    }
    if (message.type === 'transfer-progress' &&
        (!GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
         !Number.isSafeInteger(message.localBytes) || message.localBytes < 0 ||
         message.localBytes > MAX_TRANSFER_BYTES ||
         !Number.isSafeInteger(message.hostStoredBytes) || message.hostStoredBytes < 0 ||
         !Number.isSafeInteger(message.pendingBytes) || message.pendingBytes < 0 ||
         message.hostStoredBytes + message.pendingBytes !== message.localBytes ||
         !Number.isSafeInteger(message.totalFrames) || message.totalFrames < 0 ||
         message.totalFrames > MAX_TRANSFER_FRAMES ||
         !Number.isSafeInteger(message.hostStoredFrames) || message.hostStoredFrames < 0 ||
         !Number.isSafeInteger(message.pendingFrames) || message.pendingFrames < 0 ||
         message.hostStoredFrames + message.pendingFrames !== message.totalFrames ||
         !Number.isSafeInteger(message.unsubmittedBytes) || message.unsubmittedBytes < 0 ||
         !Number.isSafeInteger(message.sendingBytes) || message.sendingBytes < 0 ||
         !Number.isSafeInteger(message.awaitingAckBytes) || message.awaitingAckBytes < 0 ||
         message.unsubmittedBytes + message.sendingBytes + message.awaitingAckBytes !== message.pendingBytes ||
         !['idle', 'sending', 'awaiting-ack'].includes(message.sendState) ||
         !Number.isSafeInteger(message.bufferedBytes) || message.bufferedBytes < 0 ||
         message.bufferedBytes > 64 * 1024 ||
         !(message.sendMbps === null ||
           (Number.isFinite(message.sendMbps) && message.sendMbps >= 0 && message.sendMbps <= 1000)))) {
      this.reject(socket, 'Invalid audio recovery status format.');
      return;
    }
    if (['recording-ack', 'recording-prepared'].includes(message.type) && role !== 'guest') {
      this.reject(socket, 'Only the guest can acknowledge recording commands.');
      return;
    }
    if (message.type === 'recording-started' && role !== 'guest') {
      this.reject(socket, 'Only the guest can send a recording start confirmation.');
      return;
    }
    if (message.type === 'transfer-progress' &&
        (role !== 'guest' || !this.approvedGuest || ![...this.peers.values()].includes('host'))) {
      this.reject(socket, 'Only an approved guest can report audio recovery status.');
      return;
    }
    if (message.type === 'transfer-progress') {
      const now = Date.now();
      if (now - this.lastTransferProgressAt < 1_500) {
        this.reject(socket, 'Audio recovery status updates are being sent too frequently.');
        return;
      }
      this.lastTransferProgressAt = now;
    }
    if (message.type === 'clock-ping' && role !== 'host') {
      this.reject(socket, 'Only the host can start clock synchronization.');
      return;
    }
    if (message.type === 'clock-pong' && role !== 'guest') {
      this.reject(socket, 'Only the guest can send a clock synchronization response.');
      return;
    }
    const recipientRole = role === 'host' ? 'guest' : 'host';
    const recipient = [...this.peers].find(([, peerRole]) => peerRole === recipientRole)?.[0];
    if (recipient?.readyState === WebSocket.OPEN) {
      recipient.send(event.data);
    } else if (message.type !== 'denied') {
      this.reject(socket, 'The other participant is not connected to signaling.');
    }
  }

  join(socket, message) {
    if (!message || message.type !== 'join' || !['host', 'guest'].includes(message.role)) {
      this.reject(socket, 'Invalid room join request.');
      return;
    }
    const roles = [...this.peers.values()];
    if (message.role === 'host') {
      const authSession = this.authenticatedSubjects.get(socket);
      if (!authSession?.sub || authSession.exp <= Math.floor(Date.now() / 1000)) {
        this.reject(socket, 'Recording hosts must be logged in with Auth0 and have host permissions.');
        return;
      }
      const subject = authSession.sub;
      if (this.hostSubject && this.hostSubject !== subject) {
        this.reject(socket, 'Log in with the host account that created this room.');
        return;
      }
      this.hostSubject = subject;
    }
    if (message.role === 'host' && roles.includes('host')) {
      this.reject(socket, 'A host is already connected to this room.');
      return;
    }
    if (message.role === 'guest' && (!roles.includes('host') || roles.includes('guest'))) {
      this.reject(socket, 'This room is not currently accepting participants.');
      return;
    }
    this.peers.set(socket, message.role);
    socket.send(JSON.stringify({ type: 'joined' }));
  }

  async issueTurnCredentials(hostSocket, requestId) {
    const guestSocket = [...this.peers].find(([, role]) => role === 'guest')?.[0];
    const respond = (message) => {
      const payload = JSON.stringify(message);
      for (const socket of [hostSocket, guestSocket]) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
      }
    };
    try {
      const credentials = await this.getTurnCredentials(`room:${this.roomId}`);
      respond({ type: 'turn-credentials', requestId, iceServers: credentials.iceServers });
    } catch (error) {
      respond({ type: 'turn-error', requestId, message: `Unable to issue TURN credentials: ${error.message}` });
    }
  }

  async getTurnCredentials(credentialsKey) {
    const token = this.env.TURN_API_TOKEN;
    const keyId = this.env.TURN_KEY_ID;
    const ttl = Number(this.env.TURN_CREDENTIAL_TTL_SECONDS || TURN_TTL_DEFAULT_SECONDS);
    if (typeof token !== 'string' || !token || typeof keyId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(keyId)) {
      throw Object.assign(new Error('The server-side TURN key ID or API token is not configured.'), { status: 503 });
    }
    if (!Number.isSafeInteger(ttl) || ttl < TURN_TTL_DEFAULT_SECONDS || ttl > TURN_TTL_MAX_SECONDS) {
      throw Object.assign(new Error('Configure the TURN credential TTL between 3 and 48 hours.'), { status: 503 });
    }
    const now = Date.now();
    if (this.turnCredentialsKey === credentialsKey && this.turnCredentials?.expiresAt > now + 60_000) {
      return this.turnCredentials;
    }
    if (!this.turnRateLimitConfigured) {
      throw Object.assign(new Error('The signaling rate limiting binding is missing.'), { status: 503 });
    }
    if (now - this.lastTurnAttemptAt < 60_000) {
      throw Object.assign(new Error('This room has reached its TURN credential issuance rate limit.'), { status: 429 });
    }
    this.lastTurnAttemptAt = now;

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) {
      throw Object.assign(new Error(`Cloudflare Realtime API returned HTTP ${response.status}.`), { status: 502 });
    }
    const payload = await response.json();
    if (!validTurnIceServers(payload?.iceServers)) {
      throw Object.assign(new Error('The Cloudflare Realtime API returned an invalid TURN credential response.'), { status: 502 });
    }
    this.turnCredentials = {
      iceServers: payload.iceServers,
      expiresAt: now + ttl * 1000
    };
    this.turnCredentialsKey = credentialsKey;
    return this.turnCredentials;
  }

  reject(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'rejected', message }));
      socket.close(1008, 'Rejected');
    }
    this.onClose(socket);
  }

  onClose(socket) {
    const role = this.peers.get(socket);
    if (!role) return;
    this.peers.delete(socket);
    if (role === 'guest') {
      this.approvedGuest = false;
      this.lastTransferProgressAt = 0;
    }
    if (role === 'host') {
      this.approvedGuest = false;
      for (const [peer, peerRole] of this.peers) {
        if (peerRole === 'guest') {
          this.peers.delete(peer);
          if (peer.readyState === WebSocket.OPEN) peer.close(1000, 'Host left');
        }
      }

    }
    const host = [...this.peers].find(([, peerRole]) => peerRole === 'host')?.[0];
    if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ type: 'peer-left' }));
  }
}

async function readLimitedText(request, maxBytes) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validTurnIceServers(iceServers) {
  if (!Array.isArray(iceServers) || iceServers.length < 1 || iceServers.length > 6) return false;
  let hasTurn = false;
  for (const server of iceServers) {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || !urls.length ||
        urls.some((url) => typeof url !== 'string' ||
          !/^(?:stun:stun\.cloudflare\.com:3478|turns?:turn\.cloudflare\.com:(?:3478|443|80|5349)(?:\?transport=(?:udp|tcp))?)$/u.test(url))) {
      return false;
    }
    if (urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'))) {
      hasTurn = typeof server.username === 'string' && Boolean(server.username) &&
        typeof server.credential === 'string' && Boolean(server.credential);
    }
  }
  return hasTurn;
}
