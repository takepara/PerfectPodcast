import { turnPermitSigningMessage } from '../shared/turn-permit.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ALLOWED_MESSAGES = {
  host: new Set(['approved', 'denied', 'offer', 'auth-confirm', 'candidate', 'ice-restart', 'recording-state', 'ready-state', 'clock-ping', 'turn-request']),
  guest: new Set(['join-request', 'answer', 'candidate', 'ice-restart-answer', 'recording-ack', 'ready-state', 'clock-pong', 'recording-started', 'transfer-progress'])
};
const RECORDING_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TURN_REQUEST_ID_PATTERN = RECORDING_EVENT_ID_PATTERN;
const MAX_TRANSFER_FRAMES = 2 * 60 * 60 * 48_000;
const MAX_TRANSFER_TAKES = 1_000_000;
const MAX_TRANSFER_BYTES = MAX_TRANSFER_FRAMES * 3 + MAX_TRANSFER_TAKES * 44;
const TURN_TTL_DEFAULT_SECONDS = 10_800;
const TURN_TTL_MAX_SECONDS = 172_800;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
      const room = env.ROOMS.getByName(roomId);
      const headers = new Headers(request.headers);
      headers.set('x-signal-rate-limit-configured', String(rateLimitConfigured));
      return room.fetch(new Request(request, { headers }));
    }
    return env.ASSETS.fetch(request);
  }
};

export class RoomSignaling {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.peers = new Map();
    this.approvedGuest = false;
    this.turnCredentials = null;
    this.turnCredentialsPermitId = null;
    this.consumedTurnPermitId = null;
    this.roomId = null;
    this.turnRateLimitConfigured = false;
    this.lastTurnAttemptAt = 0;
    this.lastTransferProgressAt = 0;
  }

  async fetch(request) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
      return new Response('Forbidden', { status: 403 });
    }
    const roomId = new URL(request.url).pathname.slice('/signal/'.length);
    if (!ROOM_ID_PATTERN.test(roomId)) return new Response('Not found', { status: 404 });
    this.roomId = roomId;
    this.turnRateLimitConfigured = request.headers.get('x-signal-rate-limit-configured') === 'true';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', (event) => { void this.onMessage(server, event); });
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(socket, event) {
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_MESSAGE_BYTES) {
      this.reject(socket, 'メッセージが大きすぎるか形式が不正です。');
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.reject(socket, 'メッセージ形式が不正です。');
      return;
    }
    if (!this.peers.has(socket)) {
      this.join(socket, message);
      return;
    }
    const role = this.peers.get(socket);
    if (!message || typeof message.type !== 'string' || !ALLOWED_MESSAGES[role].has(message.type)) {
      this.reject(socket, '許可されていないシグナリングメッセージです。');
      return;
    }
    if (message.type === 'approved' && role !== 'host') {
      this.reject(socket, '参加を承認できるのはホストだけです。');
      return;
    }
    if (message.type === 'denied' && role !== 'host') {
      this.reject(socket, '参加申請を拒否できるのはホストだけです。');
      return;
    }
    if (message.type === 'turn-request') {
      if (role !== 'host' || !TURN_REQUEST_ID_PATTERN.test(message.requestId || '')) {
        this.reject(socket, 'TURN資格を要求できるのは有効なホストだけです。');
        return;
      }
      if (!this.approvedGuest || ![...this.peers.values()].includes('guest')) {
        this.reject(socket, 'ゲストの承認前はTURN資格を発行できません。');
        return;
      }
      if (typeof message.permit !== 'string' || message.permit.length > 4096 ||
          typeof message.hostPublicKey !== 'string' || message.hostPublicKey.length > 256) {
        this.sendTurnError(socket, message.requestId, '管理者発行のTURN room permitが必要です。');
        return;
      }
      const permit = await this.verifyTurnPermit(message.permit, message.hostPublicKey);
      if (!permit) {
        this.sendTurnError(socket, message.requestId, 'TURN room permitが無効、期限切れ、または別の部屋向けです。');
        return;
      }
      if (this.consumedTurnPermitId && this.consumedTurnPermitId !== permit.jti) {
        this.sendTurnError(socket, message.requestId, 'この部屋では別のTURN room permitを使用できません。');
        return;
      }
      this.consumedTurnPermitId = permit.jti;
      await this.issueTurnCredentials(socket, message.requestId);
      return;
    }
    if (message.type === 'approved') this.approvedGuest = true;
    if (message.type === 'denied') this.approvedGuest = false;
    if (message.type === 'recording-state' || message.type === 'recording-ack') {
      if (typeof message.recording !== 'boolean' ||
          !RECORDING_EVENT_ID_PATTERN.test(message.eventId || '') ||
          !GENERATION_PATTERN.test(message.generation || '') ||
          !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
          (message.type === 'recording-ack' && typeof message.accepted !== 'boolean')) {
        this.reject(socket, '録音状態または確認応答の形式が不正です。');
        return;
      }
    }
    if (message.type === 'recording-state' && message.recording &&
        (!Number.isFinite(message.startAt) || message.startAt <= 0 ||
         !Number.isFinite(message.clockOffsetMs) || Math.abs(message.clockOffsetMs) > 60_000 ||
         !Number.isFinite(message.startAt + message.clockOffsetMs))) {
      this.reject(socket, '録音開始時刻の形式が不正です。');
      return;
    }
    if (message.type === 'recording-state' && role !== 'host') {
      this.reject(socket, '録音状態を送信できるのはホストだけです。');
      return;
    }
    if (message.type === 'ready-state' &&
        (typeof message.ready !== 'boolean' ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isSafeInteger(message.sequence) || message.sequence < 1)) {
      this.reject(socket, '録音準備状態の形式が不正です。');
      return;
    }
    if (message.type === 'clock-ping' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.probeId || '') ||
         !GENERATION_PATTERN.test(message.generation || '') || !Number.isFinite(message.sentAt))) {
      this.reject(socket, '時刻同期要求の形式が不正です。');
      return;
    }
    if (message.type === 'clock-pong' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.probeId || '') ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isFinite(message.sentAt) || !Number.isFinite(message.receivedAt) ||
         !Number.isFinite(message.repliedAt))) {
      this.reject(socket, '時刻同期応答の形式が不正です。');
      return;
    }
    if (message.type === 'recording-started' &&
        (!RECORDING_EVENT_ID_PATTERN.test(message.eventId || '') ||
         !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
         !GENERATION_PATTERN.test(message.generation || '') ||
         !Number.isFinite(message.observedAt) || message.frame !== 0)) {
      this.reject(socket, '録音開始確認の形式が不正です。');
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
      this.reject(socket, '音源回収状況の形式が不正です。');
      return;
    }
    if (message.type === 'recording-ack' && role !== 'guest') {
      this.reject(socket, '録音確認応答を送信できるのはゲストだけです。');
      return;
    }
    if (message.type === 'recording-started' && role !== 'guest') {
      this.reject(socket, '録音開始確認を送信できるのはゲストだけです。');
      return;
    }
    if (message.type === 'transfer-progress' &&
        (role !== 'guest' || !this.approvedGuest || ![...this.peers.values()].includes('host'))) {
      this.reject(socket, '参加承認後のゲストだけが音源回収状況を通知できます。');
      return;
    }
    if (message.type === 'transfer-progress') {
      const now = Date.now();
      if (now - this.lastTransferProgressAt < 1_500) {
        this.reject(socket, '音源回収状況の通知間隔が短すぎます。');
        return;
      }
      this.lastTransferProgressAt = now;
    }
    if (message.type === 'clock-ping' && role !== 'host') {
      this.reject(socket, '時刻同期を開始できるのはホストだけです。');
      return;
    }
    if (message.type === 'clock-pong' && role !== 'guest') {
      this.reject(socket, '時刻同期応答を送信できるのはゲストだけです。');
      return;
    }
    const recipientRole = role === 'host' ? 'guest' : 'host';
    const recipient = [...this.peers].find(([, peerRole]) => peerRole === recipientRole)?.[0];
    if (recipient?.readyState === WebSocket.OPEN) {
      recipient.send(event.data);
    } else if (message.type !== 'denied') {
      this.reject(socket, '相手がシグナリングに接続していません。');
    }
  }

  join(socket, message) {
    if (!message || message.type !== 'join' || !['host', 'guest'].includes(message.role)) {
      this.reject(socket, '部屋への参加要求が不正です。');
      return;
    }
    const roles = [...this.peers.values()];
    if (message.role === 'host' && roles.includes('host')) {
      this.reject(socket, 'この部屋にはホストが既に接続しています。');
      return;
    }
    if (message.role === 'guest' && (!roles.includes('host') || roles.includes('guest'))) {
      this.reject(socket, 'この部屋は現在参加できません。');
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
      const credentials = await this.getTurnCredentials(hostSocket, this.consumedTurnPermitId);
      respond({ type: 'turn-credentials', requestId, iceServers: credentials.iceServers });
    } catch (error) {
      respond({ type: 'turn-error', requestId, message: `TURN資格を発行できません: ${error.message}` });
    }
  }

  sendTurnError(socket, requestId, message) {
    const payload = JSON.stringify({ type: 'turn-error', requestId, message });
    const guestSocket = [...this.peers].find(([, role]) => role === 'guest')?.[0];
    for (const peer of [socket, guestSocket]) {
      if (peer?.readyState === WebSocket.OPEN) peer.send(payload);
    }
  }

  async verifyTurnPermit(permit, hostPublicKey) {
    if (!this.env.TURN_PERMIT_PUBLIC_KEY) return null;
    const parts = permit.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return null;
    let payload;
    let signature;
    let publicKeyBytes;
    try {
      payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
      signature = decodeBase64Url(parts[1]);
      publicKeyBytes = decodeBase64Url(hostPublicKey);
    } catch {
      return null;
    }
    const now = Date.now();
    if (!payload || payload.v !== 1 || payload.roomId !== this.roomId ||
        !ROOM_ID_PATTERN.test(payload.roomId || '') ||
        typeof payload.hostKeyHash !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(payload.hostKeyHash) ||
        !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
        payload.issuedAt > now + 60_000 || payload.issuedAt < now - 86_400_000 ||
        payload.expiresAt <= now || payload.expiresAt > payload.issuedAt + 86_400_000 ||
        !/^[A-Za-z0-9_-]{22}$/u.test(payload.jti || '') || payload.maxGuests !== 1 ||
        publicKeyBytes.length < 64 || publicKeyBytes.length > 256) {
      return null;
    }
    const actualHostKeyHash = encodeBase64Url(await crypto.subtle.digest('SHA-256', publicKeyBytes));
    if (actualHostKeyHash !== payload.hostKeyHash) return null;
    let permitKey;
    try {
      permitKey = await crypto.subtle.importKey(
        'spki',
        decodeBase64Url(this.env.TURN_PERMIT_PUBLIC_KEY),
        { name: 'Ed25519' },
        false,
        ['verify']
      );
    } catch {
      return null;
    }
    try {
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        permitKey,
        signature,
        new TextEncoder().encode(turnPermitSigningMessage(payload))
      );
      return valid ? payload : null;
    } catch {
      return null;
    }
  }

  async getTurnCredentials(hostSocket, permitId) {
    const token = this.env.TURN_API_TOKEN;
    const keyId = this.env.TURN_KEY_ID;
    const ttl = Number(this.env.TURN_CREDENTIAL_TTL_SECONDS || TURN_TTL_DEFAULT_SECONDS);
    if (typeof token !== 'string' || !token || typeof keyId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(keyId)) {
      throw new Error('サーバー側のTURN key ID/API tokenが未設定です。');
    }
    if (!Number.isSafeInteger(ttl) || ttl < TURN_TTL_DEFAULT_SECONDS || ttl > TURN_TTL_MAX_SECONDS) {
      throw new Error('TURN資格TTLは3時間以上48時間以下で設定してください。');
    }
    const now = Date.now();
    if (this.turnCredentialsPermitId === permitId && this.turnCredentials?.expiresAt > now + 60_000) {
      return this.turnCredentials;
    }
    if (!this.turnRateLimitConfigured) throw new Error('シグナリングのRate Limiting bindingがありません。');
    if (now - this.lastTurnAttemptAt < 60_000) {
      throw new Error('この部屋からのTURN資格発行頻度が上限に達しました。');
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
    if (!response.ok) throw new Error(`Cloudflare Realtime API returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (!validTurnIceServers(payload?.iceServers)) {
      throw new Error('Cloudflare Realtime APIのTURN資格応答が不正です。');
    }
    this.turnCredentials = {
      iceServers: payload.iceServers,
      expiresAt: now + ttl * 1000
    };
    this.turnCredentialsPermitId = permitId;
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

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Invalid base64url value.');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
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
