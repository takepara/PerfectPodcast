const $ = (id) => document.getElementById(id);
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SIGNAL_RETRIES = 3;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function fingerprintFromSdp(sdp) {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9A-F:]+)\r?$/imu);
  if (!match) throw new Error('WebRTC のDTLS fingerprintを取得できませんでした。');
  return match[1].replaceAll(':', '').toLowerCase();
}

export function transcript(fields) {
  return [
    'PerfectPodcast room authentication v1',
    fields.roomId,
    fields.generation,
    fields.hostNonce,
    fields.guestNonce,
    fields.hostFingerprint,
    fields.guestFingerprint || '',
    fields.guestPublicKey
  ].join('\n');
}

async function sign(privateKey, message) {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message)
  )));
}

async function verify(publicKey, signature, message) {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    fromBase64Url(signature),
    new TextEncoder().encode(message)
  );
}

async function importPublicKey(value) {
  return crypto.subtle.importKey(
    'spki',
    fromBase64Url(value),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

export async function invitationProof(secret, roomId, nonce, publicKey, issuedAt) {
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`PerfectPodcast invite v1\n${roomId}\n${nonce}\n${issuedAt}\n${publicKey}`)
  )));
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function signalingUrl(roomId) {
  const url = new URL(`/signal/${roomId}`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export class RoomCall {
  constructor({ getSession, getParticipantName, getMicrophoneStream, releaseMicrophone, onError }) {
    this.getSession = getSession;
    this.getParticipantName = getParticipantName;
    this.getMicrophoneStream = getMicrophoneStream;
    this.releaseMicrophone = releaseMicrophone;
    this.onError = onError;
    this.socket = null;
    this.peerConnection = null;
    this.localRole = null;
    this.room = null;
    this.hostKeys = null;
    this.guestIdentity = null;
    this.guestNonce = null;
    this.pendingGuest = null;
    this.usedNonces = new Map();
    this.authFields = null;
    this.localSender = null;
    this.pendingCandidates = [];
    this.connected = false;
    this.retryCount = 0;
    this.disconnectTimer = null;
    this.socketReady = null;
    this.invitation = this.readInvitation();
    this.bindControls();
  }

  get isActive() {
    return Boolean(this.peerConnection || this.socket);
  }

  readInvitation() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const roomId = params.get('session');
    const secret = params.get('invite');
    const hostPublicKey = params.get('host');
    if (!roomId && !secret && !hostPublicKey) return null;
    if (!roomId || !ROOM_ID_PATTERN.test(roomId) || !secret || !hostPublicKey) {
      this.setStatus('招待リンクが正しくありません。ホストに新しいリンクを依頼してください。', true);
      return null;
    }
    try {
      if (fromBase64Url(secret).length !== 32 || fromBase64Url(hostPublicKey).length < 64) throw new Error();
    } catch {
      this.setStatus('招待リンクが正しくありません。ホストに新しいリンクを依頼してください。', true);
      return null;
    }
    return { roomId, secret, hostPublicKey };
  }

  bindControls() {
    $('createRoomButton').addEventListener('click', () => { void this.createRoom(); });
    $('joinRoomButton').addEventListener('click', () => { void this.requestJoin(); });
    $('approveGuestButton').addEventListener('click', () => { void this.approveGuest(); });
    $('denyGuestButton').addEventListener('click', () => this.denyGuest());
    $('leaveRoomButton').addEventListener('click', () => { void this.leave(); });
    $('copyInviteButton').addEventListener('click', () => { void this.copyInvite(); });
    $('playRemoteAudioButton').addEventListener('click', () => { void this.playRemoteAudio(); });
    if (this.invitation) {
      $('createRoomButton').hidden = true;
      $('joinRoomButton').hidden = false;
      this.setStatus('招待を確認しました。名前を確認し、参加申請してください。');
    }
  }

  setStatus(message, isError = false) {
    const status = $('roomStatus');
    if (status) {
      status.textContent = message;
      status.classList.toggle('room-error', isError);
    }
  }

  setCallState(message) {
    $('callState').textContent = message;
  }

  async createRoom() {
    if (!this.getSession()) {
      this.setStatus('先にスタジオを開いてください。', true);
      return;
    }
    $('createRoomButton').disabled = true;
    this.setStatus('招待を準備しています…');
    try {
      this.room = {
        roomId: randomToken(),
        secret: randomToken(),
        generation: randomToken(16)
      };
      this.hostKeys = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', this.hostKeys.publicKey)));
      this.localRole = 'host';
      await this.openSocket(this.room.roomId, 'host');
      const url = new URL(window.location.href);
      url.hash = new URLSearchParams({
        session: this.room.roomId,
        invite: this.room.secret,
        host: publicKey
      }).toString();
      $('inviteUrl').value = url.toString();
      $('inviteField').hidden = false;
      $('createRoomButton').hidden = true;
      $('leaveRoomButton').hidden = false;
      this.setStatus('招待を作成しました。リンクを相手に共有してください。');
      this.setCallState('相手の参加申請を待っています');
    } catch (error) {
      this.setStatus(`招待を作成できませんでした: ${error.message}`, true);
      this.resetRoomState();
    } finally {
      $('createRoomButton').disabled = false;
    }
  }

  async requestJoin() {
    if (!this.invitation || !this.getSession()) return;
    $('joinRoomButton').disabled = true;
    this.setStatus('マイクを確認して参加申請しています…');
    try {
      await this.getMicrophoneStream();
      this.guestIdentity = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', this.guestIdentity.publicKey)));
      const nonce = randomToken();
      const issuedAt = Date.now();
      this.guestNonce = nonce;
      const proof = await invitationProof(this.invitation.secret, this.invitation.roomId, nonce, publicKey, issuedAt);
      this.localRole = 'guest';
      await this.openSocket(this.invitation.roomId, 'guest');
      this.send({
        type: 'join-request',
        name: (this.getSession().participant || this.getParticipantName()).trim().slice(0, 60),
        nonce,
        issuedAt,
        publicKey,
        proof
      });
      this.setStatus('参加申請を送りました。ホストの承認を待っています。');
      this.setCallState('ホストの承認待ち');
      $('joinRoomButton').hidden = true;
      $('leaveRoomButton').hidden = false;
    } catch (error) {
      this.setStatus(`参加申請に失敗しました: ${error.message}`, true);
      await this.leave({ keepMessage: true });
      $('joinRoomButton').disabled = false;
    }
  }

  openSocket(roomId, role) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(signalingUrl(roomId));
      this.socket = socket;
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('シグナリング接続がタイムアウトしました。'));
      }, 10000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'join', role })), { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          socket.close();
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            reject(new Error('シグナリング応答を読み取れませんでした。'));
          }
          return;
        }
        if (message.type === 'joined' && !settled) {
          settled = true;
          window.clearTimeout(timeout);
          resolve();
        } else if (message.type === 'rejected' && !settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error(message.message || '部屋に参加できません。'));
        }
        void this.handleMessage(message);
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error('シグナリングサーバーへ接続できません。HTTPSでWorkerを起動してください。'));
      }, { once: true });
      socket.addEventListener('close', () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error('シグナリングサーバーが接続を拒否しました。'));
        } else if (this.socket === socket && this.localRole) {
          this.setCallState('接続が切れました。録音データはこの端末に保存されています。');
        }
      });
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('相手とのシグナリング接続がありません。');
    }
    this.socket.send(JSON.stringify(message));
  }

  async handleMessage(message) {
    try {
      if (message.type === 'rejected') {
        this.setStatus(message.message || '部屋に参加できません。', true);
        return;
      }
      if (message.type === 'join-request' && this.localRole === 'host') {
        await this.receiveJoinRequest(message);
      } else if (message.type === 'approved' && this.localRole === 'guest') {
        this.setStatus('ホストが参加を承認しました。通話を接続しています…');
      } else if (message.type === 'denied') {
        this.setStatus('ホストが参加申請を拒否しました。', true);
        await this.leave({ keepMessage: true });
      } else if (message.type === 'offer' && this.localRole === 'guest') {
        await this.receiveOffer(message);
      } else if (message.type === 'answer' && this.localRole === 'host') {
        await this.receiveAnswer(message);
      } else if (message.type === 'auth-confirm' && this.localRole === 'guest') {
        await this.receiveAuthConfirm(message);
      } else if (message.type === 'candidate') {
        await this.receiveCandidate(message.candidate);
      } else if (message.type === 'peer-left' && this.localRole === 'host') {
        this.pendingGuest = null;
        this.peerConnection?.close();
        this.peerConnection = null;
        this.localSender = null;
        this.setCallState('相手が退出しました。新しい参加申請を待っています。');
        this.setStatus('相手との接続が終了しました。');
      } else if (message.type === 'ice-restart' && this.localRole === 'guest') {
        await this.answerIceRestart(message);
      } else if (message.type === 'ice-restart-answer' && this.localRole === 'host') {
        await this.receiveIceRestartAnswer(message);
      }
    } catch (error) {
      this.setStatus(`通話を確立できませんでした: ${error.message}`, true);
      await this.leave({ keepMessage: true });
      this.onError?.(error);
    }
  }

  async receiveJoinRequest(message) {
    if (this.pendingGuest || this.peerConnection) {
      this.send({ type: 'denied' });
      return;
    }
    if (typeof message.name !== 'string' || !message.name.trim() || message.name.trim().length > 60 ||
        typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(message.nonce) ||
        !Number.isSafeInteger(message.issuedAt) || Math.abs(Date.now() - message.issuedAt) > 5 * 60 * 1000 ||
        typeof message.proof !== 'string' || typeof message.publicKey !== 'string') {
      this.send({ type: 'denied' });
      return;
    }
    const nonceTime = this.usedNonces.get(message.nonce);
    if (nonceTime) {
      this.send({ type: 'denied' });
      return;
    }
    let key;
    try {
      key = await importPublicKey(message.publicKey);
      const expected = await invitationProof(this.room.secret, this.room.roomId, message.nonce, message.publicKey, message.issuedAt);
      if (!sameBytes(fromBase64Url(expected), fromBase64Url(message.proof))) throw new Error('招待資格が一致しません。');
    } catch {
      this.send({ type: 'denied' });
      this.setStatus('有効な招待資格を確認できない参加申請を拒否しました。', true);
      return;
    }
    if (this.usedNonces.has(message.nonce)) {
      this.send({ type: 'denied' });
      return;
    }
    for (const [nonce, createdAt] of this.usedNonces) {
      if (Date.now() - createdAt > 5 * 60 * 1000) this.usedNonces.delete(nonce);
    }
    if (this.usedNonces.size >= 128) {
      this.send({ type: 'denied' });
      this.setStatus('参加申請の上限に達しました。この部屋を閉じて新しい招待を作成してください。', true);
      return;
    }
    this.usedNonces.set(message.nonce, message.issuedAt);
    this.pendingGuest = {
      name: message.name.trim(),
      nonce: message.nonce,
      publicKey: message.publicKey,
      verifyKey: key
    };
    $('guestRequest').textContent = `${this.pendingGuest.name} さんが参加を申請しています。相手の本人性は表示名では確認できません。`;
    $('guestRequest').hidden = false;
    $('approveGuestButton').hidden = false;
    $('denyGuestButton').hidden = false;
    this.setStatus('参加申請が届きました。内容を確認して承認してください。');
  }

  async approveGuest() {
    if (!this.pendingGuest || !this.room || !this.hostKeys) return;
    $('approveGuestButton').disabled = true;
    $('denyGuestButton').disabled = true;
    try {
      this.send({ type: 'approved' });
      await this.createPeerConnection();
      const transceiver = this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
      this.prepareOpus(transceiver);
      this.localSender = transceiver.sender;
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this.authFields = {
        roomId: this.room.roomId,
        generation: this.room.generation,
        hostNonce: randomToken(),
        guestNonce: this.pendingGuest.nonce,
        hostFingerprint: fingerprintFromSdp(this.peerConnection.localDescription.sdp),
        guestPublicKey: this.pendingGuest.publicKey
      };
      const signature = await sign(this.hostKeys.privateKey, transcript(this.authFields));
      this.send({
        type: 'offer',
        sdp: this.peerConnection.localDescription.sdp,
        auth: { ...this.authFields, signature }
      });
      $('guestRequest').hidden = true;
      $('approveGuestButton').hidden = true;
      $('denyGuestButton').hidden = true;
      this.setStatus('認証付きWebRTC接続を確立しています。認証完了までマイク音声は送信されません。');
      this.setCallState('通話を接続しています…');
    } catch (error) {
      this.setStatus(`参加者を承認できませんでした: ${error.message}`, true);
      $('approveGuestButton').disabled = false;
      $('denyGuestButton').disabled = false;
      await this.leave({ keepMessage: true });
    }
  }

  denyGuest() {
    if (!this.pendingGuest) return;
    this.send({ type: 'denied' });
    this.pendingGuest = null;
    $('guestRequest').hidden = true;
    $('approveGuestButton').hidden = true;
    $('denyGuestButton').hidden = true;
    this.setStatus('参加申請を拒否しました。');
  }

  async createPeerConnection() {
    if (!window.RTCPeerConnection) throw new Error('このブラウザーはWebRTCに対応していません。');
    this.peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
    this.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate && this.socket?.readyState === WebSocket.OPEN) {
        this.send({ type: 'candidate', candidate: candidate.toJSON() });
      }
    });
    this.peerConnection.addEventListener('track', ({ streams }) => {
      if (streams[0]) {
        $('remoteAudio').srcObject = streams[0];
        void this.playRemoteAudio();
      }
    });
    this.peerConnection.addEventListener('connectionstatechange', () => {
      const state = this.peerConnection?.connectionState;
      if (state === 'connected') {
        window.clearTimeout(this.disconnectTimer);
        this.retryCount = 0;
        this.setCallState('通話中 · Opus');
      } else if (state === 'failed') {
        this.setCallState('接続に失敗しました。再接続またはローカル録音を続けてください。');
        this.scheduleIceRestart(0);
      } else if (state === 'disconnected') {
        this.setCallState('接続が不安定です。再接続を試しています…');
        this.scheduleIceRestart();
      }
    });
    this.peerConnection.addEventListener('iceconnectionstatechange', () => {
      if (this.peerConnection?.iceConnectionState === 'disconnected') this.scheduleIceRestart();
    });
  }

  prepareOpus(transceiver) {
    const codecs = RTCRtpSender.getCapabilities?.('audio')?.codecs || [];
    const opus = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
    if (!opus.length || !transceiver.setCodecPreferences) {
      throw new Error('Opusの選択を確認できないため、この環境では通話を開始できません。');
    }
    transceiver.setCodecPreferences(opus);
  }

  async receiveOffer(message) {
    if (!this.invitation || !this.guestIdentity || !message.auth || typeof message.sdp !== 'string') {
      throw new Error('認証情報を含まない通話招待を拒否しました。');
    }
    const auth = message.auth;
    if (auth.roomId !== this.invitation.roomId || auth.guestNonce === undefined ||
        auth.guestPublicKey !== toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', this.guestIdentity.publicKey)))) {
      throw new Error('別の部屋または参加者向けの通話招待です。');
    }
    const hostKey = await importPublicKey(this.invitation.hostPublicKey);
    await this.createPeerConnection();
    await this.peerConnection.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    await this.flushCandidates();
    const actualHostFingerprint = fingerprintFromSdp(this.peerConnection.remoteDescription.sdp);
    if (auth.guestNonce !== this.guestNonce || auth.hostFingerprint !== actualHostFingerprint ||
        !(await verify(hostKey, auth.signature, transcript(auth)))) {
      throw new Error('ホスト署名またはDTLS fingerprintが一致しません。');
    }
    const transceiver = this.peerConnection.getTransceivers().find((item) => item.receiver.track.kind === 'audio');
    if (!transceiver) throw new Error('音声通話用トランシーバーがありません。');
    this.prepareOpus(transceiver);
    transceiver.direction = 'sendrecv';
    this.localSender = transceiver.sender;
    await this.peerConnection.setLocalDescription(await this.peerConnection.createAnswer());
    const guestFingerprint = fingerprintFromSdp(this.peerConnection.localDescription.sdp);
    this.authFields = { ...auth, guestFingerprint };
    const signature = await sign(this.guestIdentity.privateKey, transcript(this.authFields));
    this.send({
      type: 'answer',
      sdp: this.peerConnection.localDescription.sdp,
      auth: { ...this.authFields, signature }
    });
    this.setStatus('応答を送信しました。DTLS認証完了までマイク音声は送信されません。');
  }

  async receiveAnswer(message) {
    if (!this.peerConnection || !this.pendingGuest || !message.auth || typeof message.sdp !== 'string') {
      throw new Error('認証されていない通話応答です。');
    }
    await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    const auth = message.auth;
    const actualGuestFingerprint = fingerprintFromSdp(this.peerConnection.remoteDescription.sdp);
    const expectedFields = { ...this.authFields, guestFingerprint: actualGuestFingerprint };
    if (auth.roomId !== expectedFields.roomId || auth.generation !== expectedFields.generation ||
        auth.hostNonce !== expectedFields.hostNonce || auth.guestNonce !== expectedFields.guestNonce ||
        auth.hostFingerprint !== expectedFields.hostFingerprint ||
        auth.guestPublicKey !== expectedFields.guestPublicKey ||
        auth.guestFingerprint !== actualGuestFingerprint ||
        !(await verify(this.pendingGuest.verifyKey, auth.signature, transcript(expectedFields)))) {
      throw new Error('参加者署名またはDTLS fingerprintが一致しません。');
    }
    this.authFields = expectedFields;
    const signature = await sign(this.hostKeys.privateKey, transcript(this.authFields));
    this.send({ type: 'auth-confirm', auth: { ...this.authFields, signature } });
    await this.attachLocalAudio();
    this.connected = true;
    this.setStatus('参加者の署名とDTLS fingerprintを確認しました。');
    this.setCallState('通話を接続しています…');
    await this.flushCandidates();
  }

  async receiveAuthConfirm(message) {
    if (!this.peerConnection || !this.guestIdentity || !this.authFields || !message.auth) {
      throw new Error('ホストの認証確認がありません。');
    }
    const auth = message.auth;
    const actualHostFingerprint = fingerprintFromSdp(this.peerConnection.remoteDescription.sdp);
    if (auth.roomId !== this.authFields.roomId || auth.generation !== this.authFields.generation ||
        auth.hostNonce !== this.authFields.hostNonce || auth.guestNonce !== this.guestNonce ||
        auth.hostFingerprint !== actualHostFingerprint ||
        auth.guestFingerprint !== fingerprintFromSdp(this.peerConnection.localDescription.sdp) ||
        auth.guestPublicKey !== this.authFields.guestPublicKey ||
        !(await verify(await importPublicKey(this.invitation.hostPublicKey), auth.signature, transcript(this.authFields)))) {
      throw new Error('ホストの署名確認またはDTLS fingerprintが一致しません。');
    }
    await this.attachLocalAudio();
    this.connected = true;
    this.setStatus('ホストと双方の署名・DTLS fingerprintを確認しました。');
    this.setCallState('通話を接続しています…');
  }

  async receiveCandidate(candidate) {
    if (!candidate || !this.peerConnection) return;
    if (!this.peerConnection.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
  }

  async flushCandidates() {
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  async answerIceRestart(message) {
    if (!this.peerConnection || typeof message.sdp !== 'string') return;
    await this.peerConnection.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    await this.flushCandidates();
    await this.peerConnection.setLocalDescription(await this.peerConnection.createAnswer());
    this.send({ type: 'ice-restart-answer', sdp: this.peerConnection.localDescription.sdp });
  }

  async receiveIceRestartAnswer(message) {
    if (!this.peerConnection || typeof message.sdp !== 'string') return;
    await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    await this.flushCandidates();
  }

  scheduleIceRestart(delay = 5000) {
    window.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = window.setTimeout(() => {
      void this.restartIce();
    }, delay);
  }

  async restartIce() {
    if (this.localRole !== 'host' || !this.peerConnection) return;
    if (this.retryCount >= MAX_SIGNAL_RETRIES) {
      this.setCallState('再接続を中断しました。通話を終了するか、録音をローカルで続けてください。');
      return;
    }
    this.retryCount += 1;
    try {
      this.peerConnection.restartIce();
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      this.send({ type: 'ice-restart', sdp: this.peerConnection.localDescription.sdp });
      this.setCallState(`再接続中 (${this.retryCount}/${MAX_SIGNAL_RETRIES})`);
    } catch (error) {
      this.setCallState(`再接続に失敗しました: ${error.message}`);
    }
  }

  async attachLocalAudio() {
    if (!this.localSender) throw new Error('送信用オーディオトラックがありません。');
    const stream = await this.getMicrophoneStream();
    await this.localSender.replaceTrack(stream.getAudioTracks()[0]);
    const parameters = this.localSender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 32000;
    try {
      await this.localSender.setParameters(parameters);
    } catch {
      this.setStatus('通話は認証済みです。32 kbps上限を設定できず、ブラウザー既定値で接続しています。');
    }
  }

  async playRemoteAudio() {
    try {
      await $('remoteAudio').play();
      $('playRemoteAudioButton').hidden = true;
    } catch {
      $('playRemoteAudioButton').hidden = false;
      this.setCallState('ブラウザーが自動再生を制限しています。「相手の音声を再生」を押してください。');
    }
  }

  async copyInvite() {
    try {
      await navigator.clipboard.writeText($('inviteUrl').value);
      this.setStatus('招待リンクをコピーしました。相手だけに共有してください。');
    } catch {
      $('inviteUrl').focus();
      $('inviteUrl').select();
      this.setStatus('自動コピーできませんでした。選択されたリンクをコピーしてください。', true);
    }
  }

  async leave({ keepMessage = false } = {}) {
    window.clearTimeout(this.disconnectTimer);
    const previousRole = this.localRole;
    this.peerConnection?.close();
    this.peerConnection = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
    }
    this.localRole = null;
    this.pendingGuest = null;
    this.guestIdentity = null;
    this.guestNonce = null;
    this.authFields = null;
    this.localSender = null;
    this.pendingCandidates = [];
    this.connected = false;
    $('remoteAudio').srcObject = null;
    $('leaveRoomButton').hidden = true;
    $('guestRequest').hidden = true;
    $('approveGuestButton').hidden = true;
    $('denyGuestButton').hidden = true;
    $('approveGuestButton').disabled = false;
    $('denyGuestButton').disabled = false;
    $('playRemoteAudioButton').hidden = true;
    if (this.invitation) {
      $('joinRoomButton').hidden = false;
      $('joinRoomButton').disabled = false;
    } else {
      $('createRoomButton').hidden = false;
    }
    await this.releaseMicrophone();
    if (previousRole === 'host') this.resetRoomState();
    this.setCallState('通話は未接続です');
    if (!keepMessage) this.setStatus('通話を終了しました。ローカル録音データはこの端末に残っています。');
  }

  resetRoomState() {
    this.room = null;
    this.hostKeys = null;
    this.localRole = null;
    this.pendingGuest = null;
    $('inviteField').hidden = true;
    $('leaveRoomButton').hidden = true;
    $('createRoomButton').hidden = false;
  }
}
