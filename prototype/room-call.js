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
  constructor({
    getSession,
    getParticipantName,
    getMicrophoneStream,
    releaseMicrophone,
    getRecordingState,
    onRecordingState,
    onLocalStream,
    onError
  }) {
    this.getSession = getSession;
    this.getParticipantName = getParticipantName;
    this.getMicrophoneStream = getMicrophoneStream;
    this.releaseMicrophone = releaseMicrophone;
    this.getRecordingState = getRecordingState || (() => false);
    this.onRecordingState = onRecordingState;
    this.onLocalStream = onLocalStream;
    this.onError = onError;
    this.socket = null;
    this.peerConnection = null;
    this.localRole = null;
    this.room = null;
    this.hostKeys = null;
    this.guestIdentity = null;
    this.guestNonce = null;
    this.pendingGuest = null;
    this.remoteRecordingState = null;
    this.recordingSequence = 0;
    this.pendingRecordingCommands = new Map();
    this.guestRecordingCommands = new Map();
    this.lastGuestRecordingSequence = 0;
    this.pendingGuestRecordingCommand = null;
    this.usedNonces = new Map();
    this.authFields = null;
    this.localSender = null;
    this.pendingCandidates = [];
    this.connected = false;
    this.retryCount = 0;
    this.disconnectTimer = null;
    this.statsTimer = null;
    this.statsRefreshInProgress = false;
    this.previousStats = null;
    this.socketReady = null;
    this.remoteAudioContext = null;
    this.remoteAudioSource = null;
    this.remoteAnalyser = null;
    this.remoteSilentGain = null;
    this.remoteSamples = null;
    this.remoteHistory = new Float32Array(600);
    this.remoteHistoryCount = 0;
    this.remoteAnimationFrame = null;
    this.remoteSampledAt = 0;
    this.remoteWaveformStartedAt = 0;
    this.remoteRulerSecond = -1;
    this.remoteTrack = null;
    this.invitation = this.readInvitation();
    this.bindControls();
  }

  get isActive() {
    return Boolean(this.peerConnection || this.socket);
  }

  get isGuest() {
    return this.inviteMode;
  }

  readInvitation() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    this.inviteMode = ['session', 'invite', 'host'].some((key) => params.has(key));
    const roomId = params.get('session');
    const secret = params.get('invite');
    const hostPublicKey = params.get('host');
    if (!this.inviteMode) return null;
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
    this.applyRoleUI();
  }

  applyRoleUI() {
    const guestMode = this.inviteMode;
    $('setupTitle').textContent = guestMode ? '招待された収録' : 'ローカル録音';
    $('setupInstructions').textContent = guestMode
      ? 'あなたはゲストとして招待されています。表示名とマイクを設定してスタジオへ進み、ホストに参加申請してください。ホストが録音を操作し、あなたの音声もこの端末に自動保存されます。'
      : 'この端末で収録を始めるか、スタジオからゲストを招待できます。';
    $('setupFormTitle').textContent = guestMode ? 'ゲスト参加の準備' : '収録の準備';
    $('participantNameLabel').textContent = guestMode ? 'ホストに表示する名前' : 'あなたの名前';
    $('micDeviceLabel').textContent = guestMode ? '通話・録音に使うマイク' : '録音マイク';
    $('openStudioButton').textContent = guestMode ? 'ゲスト用スタジオへ進む' : 'スタジオを開く';
    $('openStudioButton').disabled = guestMode && !this.invitation;
    $('recentPanel').hidden = guestMode;
    $('setupView').querySelector('.setup-grid').classList.toggle('guest-mode', guestMode);
    $('roomPanel').classList.toggle('guest-mode', guestMode);
    $('roleBadge').textContent = guestMode ? 'ゲスト' : 'ホスト';
    $('roleBadge').classList.toggle('guest', guestMode);
    $('roomRoleLabel').textContent = guestMode ? 'ゲスト操作' : 'ホスト操作';
    $('roomHeading').textContent = guestMode ? '招待された部屋に参加' : 'ゲストを招待';
    $('roomInstructions').textContent = guestMode
      ? 'ホストに参加申請を送り、承認されると音声通話が始まります。'
      : '招待リンクを共有し、参加申請が届いたら相手を確認して承認してください。';
    $('createRoomButton').hidden = guestMode;
    $('joinRoomButton').hidden = !guestMode || !this.invitation;
    $('joinRoomButton').disabled = guestMode && !this.invitation;
    $('recordControls').hidden = guestMode;
    $('hostRecordingNotice').hidden = !guestMode;
    $('joinRoomButton').textContent = 'ホストに参加申請';
    $('takesHeading').textContent = guestMode ? 'この端末のゲスト録音' : 'このセッションの録音';
    $('remoteWaveformTitle').textContent = guestMode ? 'ホストのトラック' : 'ゲストのトラック';
    $('remoteWaveformParticipant').textContent = guestMode ? 'ホスト' : 'ゲスト';
    this.setRemoteWaveState('未接続');
    if (guestMode && !this.invitation) {
      $('setupInstructions').textContent = '招待リンクが正しくありません。ホストに新しいリンクを依頼してください。';
      $('setupInstructions').classList.add('setup-error');
      $('setupMessage').textContent = 'このリンクからゲスト参加できません。';
    } else if (guestMode) {
      this.setStatus('招待を確認しました。準備ができたらホストに参加申請してください。');
    } else {
      this.setStatus('招待リンクを作成してゲストを招待できます。');
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

  setHostRecordingState(recording) {
    if (this.localRole !== 'host') return;
    if (typeof recording !== 'boolean') {
      this.setStatus('録音状態をゲストへ同期できませんでした。', true);
      return;
    }
    if (!this.connected) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus('ゲストとの接続がないため、録音状態を同期できませんでした。', true);
      if (recording) void this.onRecordingState?.(false);
      return;
    }
    for (const pending of this.pendingRecordingCommands.values()) window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.clear();
    const command = {
      type: 'recording-state',
      recording,
      eventId: crypto.randomUUID(),
      sequence: ++this.recordingSequence
    };
    const pending = { ...command, retries: 0, timer: null };
    this.pendingRecordingCommands.set(command.eventId, pending);
    this.sendRecordingCommand(pending);
  }

  sendRecordingCommand(pending) {
    try {
      this.send({
        type: 'recording-state',
        recording: pending.recording,
        eventId: pending.eventId,
        sequence: pending.sequence
      });
      pending.timer = window.setTimeout(() => {
        if (this.pendingRecordingCommands.get(pending.eventId) !== pending) return;
        if (pending.retries < 3) {
          pending.retries += 1;
          this.sendRecordingCommand(pending);
          return;
        }
        this.pendingRecordingCommands.delete(pending.eventId);
        this.setStatus('ゲストから録音状態の確認応答がありません。双方の録音状態を確認してください。', true);
        if (pending.recording) void this.onRecordingState?.(false);
      }, 5000);
    } catch (error) {
      this.setStatus(`ゲストへ録音状態を同期できませんでした: ${error.message}`, true);
      this.pendingRecordingCommands.delete(pending.eventId);
      if (pending.recording) void this.onRecordingState?.(false);
    }
  }

  async receiveRecordingState(message) {
    if (this.localRole !== 'guest' || typeof message.recording !== 'boolean' ||
        typeof message.eventId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(message.eventId) ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      this.setStatus('ホストから不正な録音状態が届きました。', true);
      return;
    }
    const prior = this.guestRecordingCommands.get(message.eventId);
    if (prior) {
      if (prior.recording !== message.recording || prior.sequence !== message.sequence) {
        this.setStatus('同じ録音イベントIDに異なる状態が届きました。', true);
        return;
      }
      await prior.resultPromise;
      this.sendRecordingAck(prior);
      return;
    }
    if (message.sequence <= this.lastGuestRecordingSequence) {
      this.setStatus('古い録音状態イベントを無視しました。', true);
      return;
    }
    this.lastGuestRecordingSequence = message.sequence;
    this.remoteRecordingState = message.recording;
    const command = {
      eventId: message.eventId,
      sequence: message.sequence,
      recording: message.recording,
      accepted: false,
      promise: null,
      resultPromise: null,
      resolveResult: null
    };
    command.resultPromise = new Promise((resolve) => {
      command.resolveResult = resolve;
    });
    this.guestRecordingCommands.set(message.eventId, command);
    if (this.guestRecordingCommands.size > 32) {
      const oldestId = this.guestRecordingCommands.keys().next().value;
      const oldest = this.guestRecordingCommands.get(oldestId);
      if (!oldest.promise) {
        oldest.accepted = false;
        oldest.resolveResult();
      }
      this.guestRecordingCommands.delete(oldestId);
    }
    if (this.pendingGuestRecordingCommand && this.pendingGuestRecordingCommand !== command) {
      this.pendingGuestRecordingCommand.accepted = false;
      this.pendingGuestRecordingCommand.resolveResult();
      this.pendingGuestRecordingCommand = null;
    }
    if (!this.connected && message.recording) {
      this.pendingGuestRecordingCommand = command;
      return;
    }
    await this.applyGuestRecordingCommand(command);
    this.sendRecordingAck(command);
  }

  applyGuestRecordingCommand(command) {
    if (command.promise) return command.promise;
    command.promise = Promise.resolve(this.onRecordingState?.(command.recording)).then((result) => {
      command.accepted = result !== false;
    }).catch((error) => {
      this.setStatus(`ホストの録音状態を適用できませんでした: ${error.message}`, true);
      command.accepted = false;
    }).finally(() => {
      command.resolveResult();
    });
    return command.promise;
  }

  sendRecordingAck(command) {
    try {
      this.send({
        type: 'recording-ack',
        eventId: command.eventId,
        sequence: command.sequence,
        recording: command.recording,
        accepted: command.accepted
      });
    } catch (error) {
      this.setStatus(`録音状態の確認応答を送信できませんでした: ${error.message}`, true);
    }
  }

  receiveRecordingAck(message) {
    const pending = this.pendingRecordingCommands.get(message.eventId);
    if (!pending || pending.sequence !== message.sequence || pending.recording !== message.recording ||
        typeof message.accepted !== 'boolean') return;
    window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.delete(message.eventId);
    if (message.accepted) {
      this.setStatus(message.recording ? 'ゲストの録音開始を確認しました。' : 'ゲストの録音停止と保存を確認しました。');
      return;
    }

    this.setStatus('ゲストが録音状態を適用できませんでした。双方の録音状態を確認してください。', true);
    if (pending.recording) void this.onRecordingState?.(false);
  }

  async applyPendingGuestRecordingCommand() {
    const command = this.pendingGuestRecordingCommand;
    if (!command) return;
    this.pendingGuestRecordingCommand = null;
    await this.applyGuestRecordingCommand(command);
    this.sendRecordingAck(command);
  }

  setRemoteWaveState(message, active = false) {
    const state = $('remoteWaveformState');
    if (!state) return;
    state.textContent = message;
    state.classList.toggle('remote-live', active);
  }

  async startRemoteWaveform(stream, track) {
    this.stopRemoteWaveform();
    if (!window.AudioContext) throw new Error('このブラウザーでは波形表示を利用できません。');
    this.remoteTrack = track;
    this.remoteAudioContext = new AudioContext();
    this.remoteAudioSource = this.remoteAudioContext.createMediaStreamSource(stream);
    this.remoteAnalyser = this.remoteAudioContext.createAnalyser();
    this.remoteAnalyser.fftSize = 1024;
    this.remoteSamples = new Float32Array(this.remoteAnalyser.fftSize);
    this.remoteSilentGain = this.remoteAudioContext.createGain();
    this.remoteSilentGain.gain.value = 0;
    this.remoteAudioSource.connect(this.remoteAnalyser);
    this.remoteAnalyser.connect(this.remoteSilentGain).connect(this.remoteAudioContext.destination);
    this.remoteHistory.fill(0);
    this.remoteHistoryCount = 0;
    this.remoteSampledAt = 0;
    this.remoteWaveformStartedAt = performance.now();
    this.remoteRulerSecond = -1;
    this.setRemoteWaveState(track.muted ? '音声待ち' : '波形準備中');
    this.drawRemoteWaveform();
    if (this.remoteAudioContext.state === 'suspended') {
      void this.remoteAudioContext.resume().catch((error) => {
        this.setRemoteWaveState('波形停止');
        this.setCallState(`相手の音声は接続中ですが、波形表示を開始できません: ${error.message}`);
      });
    }
  }

  drawRemoteWaveform() {
    const canvas = $('remoteWaveformCanvas');
    const context = canvas.getContext('2d');
    if (!context) {
      this.setRemoteWaveState('波形描画エラー');
      return;
    }
    if (!canvas.parentElement) {
      this.setRemoteWaveState('波形描画エラー');
      return;
    }
    const bounds = canvas.parentElement.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.beginPath();
    context.lineWidth = 1;
    context.strokeStyle = '#3b464e';
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();

    const now = performance.now();
    if (this.remoteAudioContext?.state === 'running' && this.remoteAnalyser && this.remoteSamples &&
        this.remoteTrack?.readyState === 'live' && !this.remoteTrack.muted && now - this.remoteSampledAt >= 100) {
      this.remoteAnalyser.getFloatTimeDomainData(this.remoteSamples);
      let peak = 0;
      for (const sample of this.remoteSamples) peak = Math.max(peak, Math.abs(sample));
      if (this.remoteHistoryCount === this.remoteHistory.length) {
        this.remoteHistory.copyWithin(0, 1);
        this.remoteHistory[this.remoteHistory.length - 1] = peak;
      } else {
        this.remoteHistory[this.remoteHistoryCount] = peak;
        this.remoteHistoryCount += 1;
      }
      this.remoteSampledAt = now;
      this.setRemoteWaveState('LIVE', true);
    } else if (this.remoteTrack?.muted) {
      this.setRemoteWaveState('音声待ち');
    }

    if (this.remoteHistoryCount > 0) {
      context.beginPath();
      context.lineWidth = Math.max(1, pixelRatio);
      context.strokeStyle = '#ff596b';
      context.shadowColor = 'rgb(255 89 107 / 35%)';
      context.shadowBlur = 5 * pixelRatio;
      for (let index = 0; index < this.remoteHistoryCount; index += 1) {
        const x = (index / this.remoteHistory.length) * width;
        const amplitude = Math.sqrt(Math.max(0, this.remoteHistory[index])) * height * 0.44;
        context.moveTo(x, height / 2 - amplitude);
        context.lineTo(x, height / 2 + amplitude);
      }
      context.stroke();
      context.shadowBlur = 0;
    }

    const elapsed = (now - this.remoteWaveformStartedAt) / 1000;
    const rulerSecond = Math.floor(elapsed);
    if (rulerSecond !== this.remoteRulerSecond) {
      const firstMark = elapsed >= 60 ? elapsed - 60 : 0;
      for (let index = 0; index < 5; index += 1) {
        const total = Math.max(0, Math.floor(firstMark + index * 15));
        const label = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
        $('remoteWaveMark' + index).textContent = label;
      }
      this.remoteRulerSecond = rulerSecond;
    }
    this.remoteAnimationFrame = window.requestAnimationFrame(() => this.drawRemoteWaveform());
  }

  stopRemoteWaveform() {
    if (this.remoteAnimationFrame !== null) {
      window.cancelAnimationFrame(this.remoteAnimationFrame);
      this.remoteAnimationFrame = null;
    }
    this.remoteAudioSource?.disconnect();
    this.remoteAnalyser?.disconnect();
    this.remoteSilentGain?.disconnect();
    if (this.remoteAudioContext && this.remoteAudioContext.state !== 'closed') {
      void this.remoteAudioContext.close();
    }
    this.remoteAudioContext = null;
    this.remoteAudioSource = null;
    this.remoteAnalyser = null;
    this.remoteSilentGain = null;
    this.remoteSamples = null;
    this.remoteTrack = null;
    this.remoteHistory.fill(0);
    this.remoteHistoryCount = 0;
    const canvas = $('remoteWaveformCanvas');
    const context = canvas.getContext('2d');
    if (context) context.clearRect(0, 0, canvas.width, canvas.height);
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
      $('leaveRoomButton').textContent = '招待を終了';
      this.setStatus('招待を作成しました。リンクを相手に共有してください。');
      this.setCallState('相手の参加申請を待っています');
      this.setRemoteWaveState('ゲスト待ち');
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
      this.setRemoteWaveState('承認待ち');
      $('joinRoomButton').hidden = true;
      $('leaveRoomButton').hidden = false;
      $('leaveRoomButton').textContent = '参加申請を取り消す';
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
        $('leaveRoomButton').textContent = '通話を終了';
        this.setRemoteWaveState('接続中');
      } else if (message.type === 'denied') {
        this.setStatus('ホストが参加申請を拒否しました。', true);
        await this.leave({ keepMessage: true });
      } else if (message.type === 'offer' && this.localRole === 'guest') {
        await this.receiveOffer(message);
      } else if (message.type === 'answer' && this.localRole === 'host') {
        await this.receiveAnswer(message);
      } else if (message.type === 'auth-confirm' && this.localRole === 'guest') {
        await this.receiveAuthConfirm(message);
      } else if (message.type === 'recording-state') {
        await this.receiveRecordingState(message);
      } else if (message.type === 'recording-ack' && this.localRole === 'host') {
        this.receiveRecordingAck(message);
      } else if (message.type === 'candidate') {
        await this.receiveCandidate(message.candidate);
      } else if (message.type === 'peer-left' && this.localRole === 'host') {
        this.pendingGuest = null;
        this.connected = false;
        this.peerConnection?.close();
        this.peerConnection = null;
        this.localSender = null;
        this.stopRemoteWaveform();
        $('remoteAudio').srcObject = null;
        await this.releaseMicrophone();
        this.onLocalStream?.(null);
        $('guestRequestCard').hidden = true;
        $('approveGuestButton').hidden = true;
        $('denyGuestButton').hidden = true;
        $('remoteWaveformParticipant').textContent = 'ゲスト';
        this.setRemoteWaveState('未接続');
        this.setCallState('相手が退出しました。新しい参加申請を待っています。');
        this.setStatus('相手との接続が終了しました。');
        $('leaveRoomButton').textContent = '招待を終了';
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
    $('guestRequestName').textContent = this.pendingGuest.name;
    $('remoteWaveformParticipant').textContent = this.pendingGuest.name;
    $('guestRequestCard').hidden = false;
    $('approveGuestButton').hidden = false;
    $('denyGuestButton').hidden = false;
    this.setStatus('ゲストから申請が届きました。下の申請カードで名前を確認してください。');
    this.setCallState('参加申請を確認してください');
    this.setRemoteWaveState('承認待ち');
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
      $('guestRequestCard').hidden = true;
      this.setStatus('ゲストを承認しました。安全な通話接続を確立しています。');
      this.setCallState('通話を接続しています…');
      this.setRemoteWaveState('接続中');
      $('leaveRoomButton').textContent = '通話を終了';
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
    $('guestRequestCard').hidden = true;
    $('approveGuestButton').hidden = true;
    $('denyGuestButton').hidden = true;
    this.setStatus('参加申請を拒否しました。');
    this.setCallState('申請を拒否しました。別の申請を待っています');
    this.setRemoteWaveState('ゲスト待ち');
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
    this.peerConnection.addEventListener('track', (event) => {
      const audio = $('remoteAudio');
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void this.startRemoteWaveform(audio.srcObject, event.track).catch((error) => {
        this.setRemoteWaveState('波形エラー');
        this.setStatus(`相手の波形を表示できませんでした: ${error.message}`, true);
      });
      event.track.addEventListener('unmute', () => { void this.playRemoteAudio(); });
      event.track.addEventListener('mute', () => {
        $('playRemoteAudioButton').hidden = true;
        this.setRemoteWaveState('音声停止');
        this.setCallState('相手の音声が一時中断しています。相手のマイク状態を確認してください。');
      });
      event.track.addEventListener('ended', () => {
        $('playRemoteAudioButton').hidden = true;
        this.setRemoteWaveState('終了');
        this.setCallState('相手の音声トラックが終了しました。');
      });
      if (event.track.muted) {
        this.setCallState('通話接続を待っています。相手のマイク音声はまだ届いていません。');
      } else {
        void this.playRemoteAudio();
      }
    });
    this.peerConnection.addEventListener('connectionstatechange', () => {
      const state = this.peerConnection?.connectionState;
      if (state === 'connected') {
        window.clearTimeout(this.disconnectTimer);
        this.retryCount = 0;
        this.startConnectionStats();
        if ($('playRemoteAudioButton').hidden) {
          const track = $('remoteAudio').srcObject?.getAudioTracks().find((item) => item.readyState === 'live');
          this.setCallState(track && !track.muted
            ? '通話中 · Opus · 相手の音声を受信しています'
            : '通話接続済み · 相手のマイク音声を待っています');
        }
      } else if (state === 'failed') {
        this.stopConnectionStats('接続に失敗しました。再接続を試しています。');
        this.setCallState('接続に失敗しました。再接続またはローカル録音を続けてください。');
        this.scheduleIceRestart(0);
      } else if (state === 'disconnected') {
        this.stopConnectionStats('再接続中のため統計は一時停止しています。');
        this.setCallState('接続が不安定です。再接続を試しています…');
        this.scheduleIceRestart();
      } else if (state === 'connecting' || state === 'new') {
        this.stopConnectionStats('接続確立後に統計を表示します。');
      }
    });
    this.peerConnection.addEventListener('iceconnectionstatechange', () => {
      if (this.peerConnection?.iceConnectionState === 'disconnected') this.scheduleIceRestart();
    });
  }

  startConnectionStats() {
    window.clearInterval(this.statsTimer);
    this.previousStats = null;
    $('connectionStats').hidden = false;
    $('connectionStats').textContent = '接続統計を取得しています…';
    void this.updateConnectionStats();
    this.statsTimer = window.setInterval(() => { void this.updateConnectionStats(); }, 5000);
  }

  stopConnectionStats(message) {
    window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.previousStats = null;
    const stats = $('connectionStats');
    stats.hidden = !this.peerConnection;
    stats.textContent = message;
  }

  async updateConnectionStats() {
    const peerConnection = this.peerConnection;
    if (!peerConnection || peerConnection.connectionState !== 'connected' || this.statsRefreshInProgress) return;
    this.statsRefreshInProgress = true;
    try {
      const reports = await peerConnection.getStats();
      if (this.peerConnection !== peerConnection || peerConnection.connectionState !== 'connected') return;
      const reportList = [...reports.values()];
      const pair = reportList.find((report) =>
        report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)
      );
      const inbound = reportList.find((report) =>
        report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') && !report.isRemote
      );
      const outbound = reportList.find((report) =>
        report.type === 'outbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') && !report.isRemote
      );
      const now = performance.now();
      let bitrate = null;
      if (outbound && this.previousStats && now > this.previousStats.at &&
          outbound.bytesSent >= this.previousStats.bytesSent) {
        bitrate = (outbound.bytesSent - this.previousStats.bytesSent) * 8 * 1000 / (now - this.previousStats.at);
      }
      if (outbound) this.previousStats = { at: now, bytesSent: outbound.bytesSent };

      const parts = [];
      if (pair?.currentRoundTripTime !== undefined) {
        parts.push(`RTT ${Math.round(pair.currentRoundTripTime * 1000)} ms`);
      }
      if (inbound?.jitter !== undefined) parts.push(`jitter ${Math.round(inbound.jitter * 1000)} ms`);
      if (inbound?.packetsLost !== undefined && inbound?.packetsReceived !== undefined) {
        const total = Math.max(0, inbound.packetsLost) + inbound.packetsReceived;
        if (total > 0) parts.push(`損失 ${(Math.max(0, inbound.packetsLost) * 100 / total).toFixed(1)}%`);
      }
      if (bitrate !== null) parts.push(`送信 ${Math.round(bitrate / 1000)} kbps`);
      if (pair) {
        const local = reports.get(pair.localCandidateId)?.candidateType;
        const remote = reports.get(pair.remoteCandidateId)?.candidateType;
        if (local || remote) parts.push(`経路 ${local || '?'} → ${remote || '?'}`);
      }
      const stats = $('connectionStats');
      stats.hidden = false;
      stats.textContent = parts.length ? parts.join(' · ') : 'このブラウザーでは接続統計を取得できません';
    } catch (error) {
      if (this.peerConnection !== peerConnection) return;
      $('connectionStats').hidden = false;
      $('connectionStats').textContent = `接続統計を取得できません: ${error.message}`;
    } finally {
      this.statsRefreshInProgress = false;
    }
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
    this.setHostRecordingState(Boolean(this.getRecordingState()));
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
    await this.applyPendingGuestRecordingCommand();
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
    this.onLocalStream?.(stream);
  }

  async playRemoteAudio() {
    if (this.remoteAudioContext?.state === 'suspended') {
      void this.remoteAudioContext.resume().catch((error) => {
        this.setRemoteWaveState('波形停止');
        this.setCallState(`相手の音声は接続中ですが、波形表示を開始できません: ${error.message}`);
      });
    }
    const audio = $('remoteAudio');
    const track = audio.srcObject?.getAudioTracks().find((item) => item.readyState === 'live' && !item.muted);
    if (!track) {
      $('playRemoteAudioButton').hidden = true;
      this.setCallState('相手の音声はまだ届いていません。相手のマイクと通話状態を確認してください。');
      return;
    }
    try {
      await audio.play();
      $('playRemoteAudioButton').hidden = true;
      this.setCallState('通話中 · 相手の音声を再生しています');
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        $('playRemoteAudioButton').hidden = false;
        this.setCallState('相手の音声は届いていますが、自動再生が制限されています。「音声の再生を許可」を押してください。');
        return;
      }
      $('playRemoteAudioButton').hidden = true;
      this.setCallState(`相手の音声を再生できません: ${error.message}`);
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
    for (const pending of this.pendingRecordingCommands.values()) window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.clear();
    const previousRole = this.localRole;
    const wasConnected = this.connected;
    this.peerConnection?.close();
    this.peerConnection = null;
    this.stopConnectionStats('通話は未接続です');
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
    }
    this.localRole = null;
    this.pendingGuest = null;
    this.remoteRecordingState = null;
    this.guestRecordingCommands.clear();
    this.lastGuestRecordingSequence = 0;
    this.pendingGuestRecordingCommand = null;
    this.guestIdentity = null;
    this.guestNonce = null;
    this.authFields = null;
    this.localSender = null;
    this.pendingCandidates = [];
    this.connected = false;
    $('remoteAudio').srcObject = null;
    this.stopRemoteWaveform();
    $('remoteWaveformParticipant').textContent = this.inviteMode ? 'ホスト' : 'ゲスト';
    this.setRemoteWaveState('未接続');
    $('leaveRoomButton').hidden = true;
    $('guestRequestCard').hidden = true;
    $('approveGuestButton').hidden = true;
    $('denyGuestButton').hidden = true;
    $('approveGuestButton').disabled = false;
    $('denyGuestButton').disabled = false;
    $('playRemoteAudioButton').hidden = true;
    if (this.inviteMode) {
      $('joinRoomButton').hidden = false;
      $('joinRoomButton').disabled = !this.invitation;
    } else {
      $('createRoomButton').hidden = false;
    }
    await this.releaseMicrophone();
    this.onLocalStream?.(null);
    if (previousRole === 'host') this.resetRoomState();
    this.setCallState('通話は未接続です');
    if (!keepMessage) {
      const message = previousRole === 'guest' && !wasConnected
        ? '参加申請を取り消しました。'
        : previousRole === 'host' && !wasConnected
          ? '招待を終了しました。'
          : '通話を終了しました。ローカル録音データはこの端末に残っています。';
      this.setStatus(message);
    }
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
