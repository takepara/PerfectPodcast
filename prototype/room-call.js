import { calculateIntervalStats } from './connection-stats.js';
import { calculateClockSample, selectClockSample } from './clock-sync.js';
import { RecordingTransfer } from './recording-transfer.js';

const $ = (id) => document.getElementById(id);
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SIGNAL_RETRIES = 3;
const CLOCK_PROBE_COUNT = 5;
const CLOCK_PROBE_TIMEOUT_MS = 1500;
const MIN_CLOCK_PROBE_SAMPLES = 3;

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

function isValidTurnIceServers(iceServers) {
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
      hasTurn ||= typeof server.username === 'string' && Boolean(server.username) &&
        typeof server.credential === 'string' && Boolean(server.credential);
    }
  }
  return hasTurn;
}

export function findSelectedIceCandidatePair(reports) {
  const reportList = [...reports.values()];
  const selectedPairIds = new Set(reportList
    .filter((report) => report.type === 'transport' && report.selectedCandidatePairId)
    .map((report) => report.selectedCandidatePairId));
  const pairs = reportList.filter((report) => report.type === 'candidate-pair');
  if (selectedPairIds.size > 0) {
    return pairs.find((pair) => selectedPairIds.has(pair.id)) || null;
  }
  return pairs.find((pair) => pair.selected === true) ||
    pairs.find((pair) => pair.nominated === true && pair.state === 'succeeded') ||
    null;
}

export class RoomCall {
  constructor({
    getSession,
    getParticipantName,
    getMicrophoneStream,
    releaseMicrophone,
    getRecordingState,
    checkReadiness,
    onReadinessState,
    onRecordingState,
    onLocalStream,
    getNextTransferChunk,
    prepareTransferChunk,
    markTransferChunkStored,
    getNextTransferManifest,
    hasPendingTransfer,
    markTransferManifestStored,
    getTransferInventory,
    reconcileTransferInventory,
    storeIncomingTransferChunk,
    storeIncomingTransferManifest,
    onError
  }) {
    this.getSession = getSession;
    this.getParticipantName = getParticipantName;
    this.getMicrophoneStream = getMicrophoneStream;
    this.releaseMicrophone = releaseMicrophone;
    this.getRecordingState = getRecordingState || (() => false);
    this.checkReadiness = checkReadiness || (() => true);
    this.onReadinessState = onReadinessState;
    this.onRecordingState = onRecordingState;
    this.onLocalStream = onLocalStream;
    this.onError = onError;
    this.hasPendingTransfer = hasPendingTransfer;
    this.recordingTransfer = new RecordingTransfer({
      role: null,
      isAuthorized: () => Boolean(this.connected && this.authFields && this.peerConnection),
      getGeneration: () => this.authFields?.generation,
      getNextChunk: () => getNextTransferChunk
        ? getNextTransferChunk(this.authFields?.generation)
        : null,
      markChunkStored: (...args) => {
        if (!markTransferChunkStored) throw new Error('受信確認をローカル台帳へ保存できません。');
        return markTransferChunkStored(...args);
      },
      getNextManifest: () => getNextTransferManifest
        ? getNextTransferManifest(this.authFields?.generation)
        : null,
      prepareChunk: (...args) => {
        if (!prepareTransferChunk) throw new Error('転送前hashをローカル台帳へ保存できません。');
        return prepareTransferChunk(...args);
      },
      getTransferInventory: (...args) => {
        if (!getTransferInventory) throw new Error('転送inventoryを読み出せません。');
        return getTransferInventory(...args);
      },
      reconcileTransferInventory: (...args) => {
        if (!reconcileTransferInventory) throw new Error('転送inventoryを照合できません。');
        return reconcileTransferInventory(...args);
      },
      markManifestStored: (...args) => {
        if (!markTransferManifestStored) throw new Error('最終確認をローカル台帳へ保存できません。');
        return markTransferManifestStored(...args);
      },
      storeChunk: (...args) => {
        if (!storeIncomingTransferChunk) throw new Error('受信音源の保存先がありません。');
        return storeIncomingTransferChunk(...args);
      },
      storeManifest: (...args) => {
        if (!storeIncomingTransferManifest) throw new Error('受信manifestの保存先がありません。');
        return storeIncomingTransferManifest(...args);
      },
      onStatus: (message, isError = false) => this.setStatus(message, isError)
    });
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
    this.turnIceServers = null;
    this.pendingTurnCredentials = null;
    this.pendingCandidates = [];
    this.connected = false;
    this.localReady = false;
    this.remoteReady = false;
    this.incomingMessageChain = Promise.resolve();
    this.readySequence = 0;
    this.remoteReadySequence = 0;
    this.readinessCheckInProgress = false;
    this.clockOffsetMs = null;
    this.clockSyncPromise = null;
    this.pendingClockProbes = new Map();
    this.pendingStartEvents = new Map();
    this.retryCount = 0;
    this.disconnectTimer = null;
    this.statsTimer = null;
    this.statsRefreshInProgress = false;
    this.previousStats = null;
    this.previousTransferStats = null;
    this.transferSendMbps = null;
    this.transferProgressSequence = 0;
    this.lastTransferProgressSentAt = 0;
    this.remoteTransferProgress = null;
    this.socketReady = null;
    this.remoteWaveforms = new Map();
    this.waveformRecordingStartedAt = null;
    this.invitation = this.readInvitation();
    this.bindControls();
  }

  get isActive() {
    return Boolean(this.peerConnection || this.socket);
  }

  get isGuest() {
    return this.inviteMode;
  }

  get canStartRecording() {
    if (this.localRole !== 'host' || !this.socket) return true;
    if (!this.pendingGuest && !this.peerConnection) return true;
    return this.isPeerReadyForRecording;
  }

  get isPeerReadyForRecording() {
    return this.connected && this.localReady && this.remoteReady &&
      this.socket?.readyState === WebSocket.OPEN &&
      this.peerConnection?.connectionState === 'connected';
  }

  async synchronizeClock() {
    if (this.localRole !== 'host' || !this.isPeerReadyForRecording || !this.authFields) {
      throw new Error('時刻同期には両端末のREADYと接続確認が必要です。');
    }
    if (this.clockSyncPromise) return this.clockSyncPromise;
    this.clockSyncPromise = this.measureClockOffset().finally(() => {
      this.clockSyncPromise = null;
    });
    return this.clockSyncPromise;
  }

  async measureClockOffset() {
    this.clockOffsetMs = null;
    const samples = [];
    for (let index = 0; index < CLOCK_PROBE_COUNT; index += 1) {
      const sample = await new Promise((resolve) => {
        const probeId = crypto.randomUUID();
        const sentAt = performance.now();
        const timer = window.setTimeout(() => {
          this.pendingClockProbes.delete(probeId);
          resolve(null);
        }, CLOCK_PROBE_TIMEOUT_MS);
        this.pendingClockProbes.set(probeId, {
          generation: this.authFields.generation,
          sentAt,
          resolve,
          timer
        });
        try {
          this.send({ type: 'clock-ping', probeId, generation: this.authFields.generation, sentAt });
        } catch {
          window.clearTimeout(timer);
          this.pendingClockProbes.delete(probeId);
          resolve(null);
        }
      });
      if (sample) samples.push(sample);
      if (index + 1 < CLOCK_PROBE_COUNT) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    if (!this.isPeerReadyForRecording) throw new Error('時刻同期中に通話接続が失われました。');
    const selected = selectClockSample(samples, MIN_CLOCK_PROBE_SAMPLES);
    this.clockOffsetMs = selected.offsetMs;
    this.setStatus(`開始時刻を同期しました (RTT ${Math.round(selected.roundTripMs)} ms)。`);
    return this.clockOffsetMs;
  }

  clearPendingClockProbes() {
    for (const probe of this.pendingClockProbes.values()) {
      window.clearTimeout(probe.timer);
      probe.resolve(null);
    }
    this.pendingClockProbes.clear();
  }

  receiveClockPing(message) {
    if (this.localRole !== 'guest' || !this.isPeerReadyForRecording ||
        message.generation !== this.authFields?.generation ||
        !Number.isFinite(message.sentAt) || !/^[0-9a-f-]{36}$/u.test(message.probeId || '')) return;
    const receivedAt = performance.now();
    const repliedAt = performance.now();
    try {
      this.send({
        type: 'clock-pong',
        probeId: message.probeId,
        generation: message.generation,
        sentAt: message.sentAt,
        receivedAt,
        repliedAt
      });
    } catch (error) {
      this.setStatus(`時刻同期応答を送信できませんでした: ${error.message}`, true);
    }
  }

  receiveClockPong(message) {
    if (this.localRole !== 'host' || message.generation !== this.authFields?.generation ||
        !/^[0-9a-f-]{36}$/u.test(message.probeId || '')) return;
    const probe = this.pendingClockProbes.get(message.probeId);
    if (!probe || probe.generation !== message.generation || probe.sentAt !== message.sentAt) return;
    this.pendingClockProbes.delete(message.probeId);
    window.clearTimeout(probe.timer);
    try {
      probe.resolve(calculateClockSample(
        probe.sentAt,
        message.receivedAt,
        message.repliedAt,
        performance.now()
      ));
    } catch {
      probe.resolve(null);
    }
  }

  notifyLocalRecordingStarted(event, observedAt, frame) {
    if (!event || frame !== 0) return;
    const pending = this.pendingStartEvents.get(event.eventId);
    if (!pending || pending.sequence !== event.sequence) return;
    pending.localStartedAt = observedAt;
    this.completeStartEvent(pending);
  }

  notifyRecordingStarted(event, observedAt, frame) {
    if (!event || this.localRole !== 'guest' || frame !== 0 || !this.authFields) return;
    try {
      this.send({
        type: 'recording-started',
        eventId: event.eventId,
        sequence: event.sequence,
        generation: this.authFields.generation,
        observedAt,
        frame
      });
    } catch (error) {
      this.setStatus(`録音開始の確認をホストへ送信できませんでした: ${error.message}`, true);
    }
  }

  reportRecordingStarted(event, observedAt, frame) {
    if (this.localRole === 'host') this.notifyLocalRecordingStarted(event, observedAt, frame);
    else this.notifyRecordingStarted(event, observedAt, frame);
  }

  notifyChunkCommitted(chunk, take) {
    if (this.localRole === 'guest' && take?.transferGeneration === this.authFields?.generation) {
      this.recordingTransfer.wake();
    }
  }

  notifyTakeFinalized(take) {
    if (this.localRole === 'guest' && take.transferGeneration === this.authFields?.generation) {
      this.recordingTransfer.wake();
    }
  }

  receiveRecordingStarted(message) {
    if (this.localRole !== 'host' || message.generation !== this.authFields?.generation) return;
    const pending = this.pendingStartEvents.get(message.eventId);
    if (!pending || pending.sequence !== message.sequence || message.frame !== 0 ||
        !Number.isFinite(message.observedAt)) return;
    pending.remoteStartedAt = message.observedAt - pending.clockOffsetMs;
    this.completeStartEvent(pending);
  }

  reportTransferProgress(progress) {
    if (this.localRole !== 'guest' || !this.connected || !this.authFields ||
        this.socket?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - this.lastTransferProgressSentAt < 2_000) return;
    this.transferProgressSequence += 1;
    this.lastTransferProgressSentAt = now;
    try {
      this.send({
        type: 'transfer-progress',
        generation: this.authFields.generation,
        sequence: this.transferProgressSequence,
        ...progress
      });
    } catch (error) {
      this.setStatus(`ゲストの音源回収状況を通知できません: ${error.message}`, true);
    }
  }

  receiveTransferProgress(message) {
    if (this.localRole !== 'host' || !this.connected ||
        message.generation !== this.authFields?.generation ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= (this.remoteTransferProgress?.sequence || 0)) return;
    this.remoteTransferProgress = { ...message, receivedAt: performance.now() };
  }

  completeStartEvent(pending) {
    if (pending.localStartedAt === null || pending.remoteStartedAt === null) return;
    window.clearTimeout(pending.timer);
    this.pendingStartEvents.delete(pending.eventId);
    const driftMs = pending.remoteStartedAt - pending.localStartedAt;
    const warning = Math.abs(driftMs) > 20;
    this.setStatus(
      `双方の実開始を確認しました (開始差 ${Math.round(driftMs)} ms${warning ? ' · 目標20 ms超' : ''})。`,
      warning
    );
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
    $('leaveRoomButton').addEventListener('click', () => { void this.requestLeave(); });
    $('retryTransferButton').addEventListener('click', () => this.retryRecordingTransfer());
    $('copyInviteButton').addEventListener('click', () => { void this.copyInvite(); });
    $('playRemoteAudioButton').addEventListener('click', () => { void this.playRemoteAudio(); });
    $('checkReadinessButton').addEventListener('click', () => { void this.checkLocalReadiness(); });
    this.applyRoleUI();
  }

  applyRoleUI() {
    const guestMode = this.inviteMode;
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
    $('createRoomButton').hidden = guestMode;
    $('joinRoomButton').hidden = !guestMode || !this.invitation;
    $('joinRoomButton').disabled = guestMode && !this.invitation;
    $('recordControls').hidden = guestMode;
    $('hostRecordingNotice').hidden = !guestMode;
    $('transferProgressHeading').textContent = guestMode
      ? 'ホストへの音源送信状況'
      : 'ゲスト音源の受信状況';
    $('joinRoomButton').textContent = 'ホストに参加申請';
    this.setRemoteWaveState('未接続');
    if (guestMode && !this.invitation) {
      $('setupMessage').textContent = '招待リンクが正しくありません。ホストに新しいリンクを依頼してください。';
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

  updateReadinessUI() {
    const connected = this.connected && this.socket?.readyState === WebSocket.OPEN &&
      this.peerConnection?.connectionState === 'connected';
    const waitingForGuest = this.localRole === 'host' && !this.pendingGuest && !this.peerConnection;
    $('checkReadinessButton').hidden = !connected;
    $('retryTransferButton').hidden = !connected;
    $('retryTransferButton').textContent = this.localRole === 'host'
      ? '受信状況を再確認'
      : '転送を再試行';
    $('recordingReadiness').textContent = waitingForGuest
      ? 'ゲスト未接続 · 単独録音を開始できます'
      : !connected
        ? '録音準備は未確認です'
        : !this.localReady
          ? 'この端末の録音準備が未完了です'
          : !this.remoteReady
            ? 'この端末の準備完了 · 相手の確認待ち'
            : '両端末の録音準備が完了しました';
    this.onReadinessState?.({
      connected: Boolean(connected),
      localReady: this.localReady,
      peerReady: this.remoteReady,
      canStartRecording: this.canStartRecording
    });
  }

  async checkLocalReadiness() {
    if (!this.connected || !this.authFields || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.readinessCheckInProgress) return false;
    this.readinessCheckInProgress = true;
    const generation = this.authFields.generation;
    const isCurrent = () => this.connected && this.authFields?.generation === generation &&
      this.socket?.readyState === WebSocket.OPEN;
    this.localReady = false;
    this.updateReadinessUI();
    try {
      let ready = false;
      let readinessError = null;
      try {
        ready = (await this.checkReadiness()) !== false;
      } catch (error) {
        if (!isCurrent()) return false;
        readinessError = error;
      }
      if (!isCurrent()) return false;
      this.localReady = ready;
      if (readinessError) this.setStatus(`この端末の録音準備を確認できませんでした: ${readinessError.message}`, true);
      else if (!this.localReady) this.setStatus('この端末の録音準備が完了していません。マイクと保存領域を確認してください。', true);
      this.readySequence += 1;
      try {
        this.send({
          type: 'ready-state',
          ready: this.localReady,
          generation,
          sequence: this.readySequence
        });
      } catch (error) {
        this.localReady = false;
        this.setStatus(`録音準備状態を相手へ通知できませんでした: ${error.message}`, true);
      }
      this.updateReadinessUI();
      if (this.localReady && this.remoteReady) this.setStatus('双方の録音準備が完了しました。');
      else if (this.localReady) this.setStatus('この端末の録音準備が完了しました。相手の確認を待っています。');
      return this.localReady;
    } finally {
      this.readinessCheckInProgress = false;
      this.updateReadinessUI();
    }
  }

  clearPendingStartEvents() {
    for (const event of this.pendingStartEvents.values()) window.clearTimeout(event.timer);
    this.pendingStartEvents.clear();
  }

  retryRecordingTransfer() {
    if (!this.connected) return;
    this.recordingTransfer.refreshInventory();
    this.setStatus(this.localRole === 'host'
      ? 'ホスト保存済み音源の台帳を再照合しています。'
      : '未確認音源とホスト保存済み台帳を再確認しています。');
  }

  setHostRecordingState(recording, startAt = null, clockOffsetMs = null, eventId = crypto.randomUUID()) {
    if (this.localRole !== 'host') return null;
    if (typeof recording !== 'boolean') {
      this.setStatus('録音状態をゲストへ同期できませんでした。', true);
      return null;
    }
    if (!this.connected) return null;
    if (recording && !this.canStartRecording) {
      this.setStatus('双方の録音準備と通話接続を確認してから録音を開始してください。', true);
      if (this.getRecordingState()) void this.onRecordingState?.(false);
      return null;
    }
    if (recording && (!Number.isFinite(startAt) || startAt <= performance.now() ||
        !Number.isFinite(clockOffsetMs) || Math.abs(clockOffsetMs) > 60_000 ||
        !Number.isFinite(startAt + clockOffsetMs))) {
      this.setStatus('有効な同期開始時刻がありません。時刻同期をやり直してください。', true);
      if (this.getRecordingState()) void this.onRecordingState?.(false);
      return null;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus('ゲストとの接続がないため、録音状態を同期できませんでした。', true);
      if (recording) void this.onRecordingState?.(false);
      return null;
    }
    for (const pending of this.pendingRecordingCommands.values()) window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.clear();
    this.cancelPendingTurnCredentials();
    this.clearPendingStartEvents();
    const command = {
      type: 'recording-state',
      recording,
      eventId,
      sequence: ++this.recordingSequence,
      generation: this.authFields?.generation,
      startAt,
      clockOffsetMs
    };
    if (recording) {
      const pendingStart = {
        eventId: command.eventId,
        sequence: command.sequence,
        startAt,
        clockOffsetMs,
        localStartedAt: null,
        remoteStartedAt: null,
        timer: null
      };
      pendingStart.timer = window.setTimeout(() => {
        if (this.pendingStartEvents.get(command.eventId) !== pendingStart) return;
        this.pendingStartEvents.delete(command.eventId);
        this.setStatus('参加者の実開始確認が届きませんでした。録音は継続しています。双方の録音状態を確認してください。', true);
      }, Math.max(0, startAt - performance.now()) + 5000);
      this.pendingStartEvents.set(command.eventId, pendingStart);
    }
    const pending = { ...command, retries: 0, timer: null };
    this.pendingRecordingCommands.set(command.eventId, pending);
    this.sendRecordingCommand(pending);
    return { eventId: command.eventId, sequence: command.sequence, startAt, clockOffsetMs };
  }

  sendRecordingCommand(pending) {
    try {
      const message = {
        type: 'recording-state',
        recording: pending.recording,
        eventId: pending.eventId,
        sequence: pending.sequence,
        generation: pending.generation
      };
      if (pending.recording) {
        message.startAt = pending.startAt;
        message.clockOffsetMs = pending.clockOffsetMs;
      }
      this.send(message);
      pending.timer = window.setTimeout(() => {
        if (this.pendingRecordingCommands.get(pending.eventId) !== pending) return;
        if (pending.retries < 3) {
          pending.retries += 1;
          this.sendRecordingCommand(pending);
          return;
        }
        this.pendingRecordingCommands.delete(pending.eventId);
        if (pending.recording) {
          const startEvent = this.pendingStartEvents.get(pending.eventId);
          if (startEvent) window.clearTimeout(startEvent.timer);
          this.pendingStartEvents.delete(pending.eventId);
        }
        this.setStatus('ゲストから録音状態の確認応答がありません。双方の録音状態を確認してください。', true);
        if (pending.recording) void this.onRecordingState?.(false);
      }, 5000);
    } catch (error) {
      this.setStatus(`ゲストへ録音状態を同期できませんでした: ${error.message}`, true);
      this.pendingRecordingCommands.delete(pending.eventId);
      if (pending.recording) {
        const startEvent = this.pendingStartEvents.get(pending.eventId);
        if (startEvent) window.clearTimeout(startEvent.timer);
        this.pendingStartEvents.delete(pending.eventId);
      }
      if (pending.recording) void this.onRecordingState?.(false);
    }
  }

  async receiveRecordingState(message) {
    if (this.localRole !== 'guest' || typeof message.recording !== 'boolean' ||
        typeof message.eventId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(message.eventId) ||
        message.generation !== this.authFields?.generation ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      this.setStatus('ホストから不正な録音状態が届きました。', true);
      return;
    }
    if (message.recording && (!Number.isFinite(message.startAt) || message.startAt <= 0 ||
        !Number.isFinite(message.clockOffsetMs) || Math.abs(message.clockOffsetMs) > 60_000 ||
        !Number.isFinite(message.startAt + message.clockOffsetMs))) {
      this.setStatus('開始時刻の形式が不正な録音開始指示を拒否しました。', true);
      return;
    }
    const prior = this.guestRecordingCommands.get(message.eventId);
    if (prior) {
      if (prior.recording !== message.recording || prior.sequence !== message.sequence ||
          prior.generation !== message.generation ||
          prior.startAt !== (message.recording ? message.startAt + message.clockOffsetMs : null) ||
          prior.clockOffsetMs !== (message.recording ? message.clockOffsetMs : null)) {
        this.setStatus('同じ録音イベントIDに異なる状態が届きました。', true);
        return;
      }
      await prior.resultPromise;
      this.sendRecordingAck(prior);
      return;
    }
    if (message.recording && message.startAt + message.clockOffsetMs < performance.now() + 250) {
      this.setStatus('開始予定時刻を過ぎた録音開始指示を拒否しました。', true);
      this.sendRecordingAck({
        eventId: message.eventId,
        sequence: message.sequence,
        generation: message.generation,
        recording: true,
        accepted: false
      });
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
      generation: message.generation,
      recording: message.recording,
      startAt: message.recording ? message.startAt + message.clockOffsetMs : null,
      clockOffsetMs: message.recording ? message.clockOffsetMs : null,
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
    command.promise = Promise.resolve().then(async () => {
      if (command.recording && !this.isPeerReadyForRecording) {
        this.setStatus('双方の録音準備と通話接続が有効でないため、録音開始を拒否しました。', true);
        command.accepted = false;
        return;
      }
      const result = await this.onRecordingState?.(
        command.recording,
        command.recording
          ? {
            startAt: command.startAt,
            event: { eventId: command.eventId, sequence: command.sequence }
          }
          : null
      );
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
        generation: command.generation,
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
        pending.generation !== message.generation ||
        typeof message.accepted !== 'boolean') return;
    window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.delete(message.eventId);
    if (message.accepted) {
      this.setStatus(message.recording ? 'ゲストの録音開始予定を確認しました。' : 'ゲストの録音停止と保存を確認しました。');
      return;
    }

    if (pending.recording) {
      const startEvent = this.pendingStartEvents.get(message.eventId);
      if (startEvent) window.clearTimeout(startEvent.timer);
      this.pendingStartEvents.delete(message.eventId);
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

  setRemoteWaveState(message, active = false, trackId = null) {
    const waveforms = trackId
      ? [this.remoteWaveforms.get(trackId)].filter(Boolean)
      : this.remoteWaveforms.values();
    for (const waveform of waveforms) {
      waveform.state.textContent = message;
      waveform.state.classList.toggle('remote-live', active);
    }
  }

  async startRemoteWaveform(track, participantName) {
    if (!window.AudioContext) throw new Error('このブラウザーでは波形表示を利用できません。');
    this.stopRemoteWaveform(track.id);

    const element = $('remoteWaveformTemplate').content.firstElementChild.cloneNode(true);
    const waveform = {
      id: track.id,
      element,
      track,
      canvas: element.querySelector('.remote-waveform-canvas'),
      state: element.querySelector('.remote-waveform-state'),
      labels: element.querySelectorAll('.waveform-timeline span'),
      audioContext: null,
      source: null,
      analyser: null,
      silentGain: null,
      samples: null,
      history: new Float32Array(600),
      historyCount: this.waveformRecordingStartedAt === null
        ? 0
        : Math.min(600, Math.floor(Math.max(0, performance.now() - this.waveformRecordingStartedAt) / 100)),
      animationFrame: null,
      sampledAt: this.waveformRecordingStartedAt ?? 0,
      startedAt: this.waveformRecordingStartedAt ?? performance.now(),
      rulerSecond: -1
    };
    element.querySelector('.remote-waveform-title').textContent =
      this.localRole === 'guest' ? 'ホストのトラック' : 'ゲストのトラック';
    element.querySelector('.remote-waveform-participant').textContent = participantName;
    waveform.canvas.setAttribute('aria-label', `${participantName}のマイク入力の波形`);
    $('remoteWaveformTracks').append(element);
    this.remoteWaveforms.set(waveform.id, waveform);

    try {
      waveform.audioContext = new AudioContext();
      waveform.source = waveform.audioContext.createMediaStreamSource(new MediaStream([track]));
      waveform.analyser = waveform.audioContext.createAnalyser();
      waveform.analyser.fftSize = 1024;
      waveform.samples = new Float32Array(waveform.analyser.fftSize);
      waveform.silentGain = waveform.audioContext.createGain();
      waveform.silentGain.gain.value = 0;
      waveform.source.connect(waveform.analyser);
      waveform.analyser.connect(waveform.silentGain).connect(waveform.audioContext.destination);
      this.setRemoteWaveState(track.muted ? '音声待ち' : '波形準備中', false, track.id);
      this.drawRemoteWaveform(waveform);
      if (waveform.audioContext.state === 'suspended') {
        void waveform.audioContext.resume().catch((error) => {
          this.setRemoteWaveState('波形停止', false, track.id);
          this.setCallState(`相手の音声は接続中ですが、波形表示を開始できません: ${error.message}`);
        });
      }
    } catch (error) {
      this.stopRemoteWaveform(track.id);
      throw error;
    }
  }

  beginRecordingWaveform(startedAt) {
    if (!Number.isFinite(startedAt)) throw new Error('波形の録音開始時刻が不正です。');
    this.waveformRecordingStartedAt = startedAt;
    for (const waveform of this.remoteWaveforms.values()) {
      waveform.history.fill(0);
      waveform.historyCount = 0;
      waveform.sampledAt = startedAt;
      waveform.startedAt = startedAt;
      waveform.rulerSecond = -1;
    }
  }

  endRecordingWaveform() {
    this.waveformRecordingStartedAt = null;
    const startedAt = performance.now();
    for (const waveform of this.remoteWaveforms.values()) {
      waveform.history.fill(0);
      waveform.historyCount = 0;
      waveform.sampledAt = startedAt;
      waveform.startedAt = startedAt;
      waveform.rulerSecond = -1;
    }
  }

  drawRemoteWaveform(waveform) {
    if (this.remoteWaveforms.get(waveform.id) !== waveform) return;
    const canvas = waveform.canvas;
    const context = canvas.getContext('2d');
    if (!context || !canvas.parentElement) {
      this.setRemoteWaveState('波形描画エラー', false, waveform.id);
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
    if (waveform.audioContext?.state === 'running' && waveform.track.readyState === 'live' &&
        !waveform.track.muted && now - waveform.sampledAt >= 100) {
      waveform.analyser.getFloatTimeDomainData(waveform.samples);
      let peak = 0;
      for (const sample of waveform.samples) peak = Math.max(peak, Math.abs(sample));
      if (waveform.historyCount === waveform.history.length) {
        waveform.history.copyWithin(0, 1);
        waveform.history[waveform.history.length - 1] = peak;
      } else {
        waveform.history[waveform.historyCount] = peak;
        waveform.historyCount += 1;
      }
      waveform.sampledAt = now;
      this.setRemoteWaveState('LIVE', true, waveform.id);
    } else if (waveform.track.muted) {
      this.setRemoteWaveState('音声待ち', false, waveform.id);
    }

    if (waveform.historyCount > 0) {
      context.beginPath();
      context.lineWidth = Math.max(1, pixelRatio);
      context.strokeStyle = '#ff596b';
      context.shadowColor = 'rgb(255 89 107 / 35%)';
      context.shadowBlur = 5 * pixelRatio;
      for (let index = 0; index < waveform.historyCount; index += 1) {
        const x = (index / waveform.history.length) * width;
        const amplitude = Math.sqrt(Math.max(0, waveform.history[index])) * height * 0.44;
        context.moveTo(x, height / 2 - amplitude);
        context.lineTo(x, height / 2 + amplitude);
      }
      context.stroke();
      context.shadowBlur = 0;
    }

    const elapsed = (now - waveform.startedAt) / 1000;
    const rulerSecond = Math.floor(elapsed);
    if (rulerSecond !== waveform.rulerSecond) {
      const firstMark = elapsed >= 60 ? elapsed - 60 : 0;
      for (let index = 0; index < waveform.labels.length; index += 1) {
        const total = Math.max(0, Math.floor(firstMark + index * 15));
        waveform.labels[index].textContent =
          `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      }
      waveform.rulerSecond = rulerSecond;
    }
    waveform.animationFrame = window.requestAnimationFrame(() => this.drawRemoteWaveform(waveform));
  }

  stopRemoteWaveform(trackId = null) {
    const entries = trackId
      ? [[trackId, this.remoteWaveforms.get(trackId)]]
      : [...this.remoteWaveforms.entries()];
    for (const [id, waveform] of entries) {
      if (!waveform) continue;
      if (waveform.animationFrame !== null) window.cancelAnimationFrame(waveform.animationFrame);
      waveform.source?.disconnect();
      waveform.analyser?.disconnect();
      waveform.silentGain?.disconnect();
      if (waveform.audioContext && waveform.audioContext.state !== 'closed') {
        void waveform.audioContext.close();
      }
      waveform.element.remove();
      this.remoteWaveforms.delete(id);
    }
  }

  async createRoom() {
    if (!this.getSession()) {
      this.setStatus('先にスタジオを開いてください。', true);
      return;
    }
    if (this.getRecordingState()) {
      this.setStatus('録音を停止して保存してから招待リンクを作成してください。', true);
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
      this.localReady = false;
      this.remoteReady = false;
      this.readySequence = 0;
      this.remoteReadySequence = 0;
      this.hostKeys = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', this.hostKeys.publicKey)));
      this.localRole = 'host';
      await this.openSocket(this.room.roomId, 'host');
      this.updateReadinessUI();
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
      this.incomingMessageChain = Promise.resolve();
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
          this.connected = false;
          this.localReady = false;
          this.remoteReady = false;
          this.remoteReadySequence = 0;
          this.setCallState('接続が切れました。録音データはこの端末に保存されています。');
          this.updateReadinessUI();
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

  handleMessage(message) {
    this.incomingMessageChain = this.incomingMessageChain.then(() => this.processMessage(message));
    return this.incomingMessageChain;
  }

  async processMessage(message) {
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
      } else if (message.type === 'ready-state') {
        this.receiveReadyState(message);
      } else if (message.type === 'clock-ping') {
        this.receiveClockPing(message);
      } else if (message.type === 'clock-pong') {
        this.receiveClockPong(message);
      } else if (message.type === 'recording-started') {
        this.receiveRecordingStarted(message);
      } else if (message.type === 'transfer-progress') {
        this.receiveTransferProgress(message);
      } else if (message.type === 'turn-credentials') {
        this.receiveTurnCredentials(message);
      } else if (message.type === 'turn-error') {
        this.receiveTurnError(message);
      } else if (message.type === 'candidate') {
        await this.receiveCandidate(message.candidate);
      } else if (message.type === 'peer-left' && this.localRole === 'host') {
        this.pendingGuest = null;
        this.remoteTransferProgress = null;
        this.connected = false;
        this.localReady = false;
        this.remoteReady = false;
        this.remoteReadySequence = 0;
        this.clockOffsetMs = null;
        this.clearPendingClockProbes();
        this.clearPendingStartEvents();
        for (const pending of this.pendingRecordingCommands.values()) window.clearTimeout(pending.timer);
        this.pendingRecordingCommands.clear();
        this.peerConnection?.close();
        this.peerConnection = null;
        this.localSender = null;
        this.turnIceServers = null;
        this.cancelPendingTurnCredentials();
        this.stopRemoteWaveform();
        $('remoteAudio').srcObject = null;
        await this.releaseMicrophone();
        this.onLocalStream?.(null);
        $('guestRequestCard').hidden = true;
        $('approveGuestButton').hidden = true;
        $('denyGuestButton').hidden = true;
        this.setRemoteWaveState('未接続');
        this.setCallState('相手が退出しました。新しい参加申請を待っています。');
        this.setStatus('相手との接続が終了しました。');
        this.updateReadinessUI();
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

  async requestTurnCredentials() {
    if (this.localRole !== 'host' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('TURN資格を要求できるシグナリング接続がありません。'));
    }
    if (this.pendingTurnCredentials) return this.pendingTurnCredentials.promise;
    const requestId = crypto.randomUUID();
    const hostPublicKey = toBase64Url(new Uint8Array(
      await crypto.subtle.exportKey('spki', this.hostKeys.publicKey)
    ));
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const pending = {
      requestId,
      promise,
      resolve,
      reject,
      timer: window.setTimeout(() => {
        if (this.pendingTurnCredentials !== pending) return;
        this.pendingTurnCredentials = null;
        reject(new Error('TURN資格の発行応答がタイムアウトしました。'));
      }, 10_000)
    };
    this.pendingTurnCredentials = pending;
    try {
      this.send({ type: 'turn-request', requestId });
    } catch (error) {
      window.clearTimeout(pending.timer);
      this.pendingTurnCredentials = null;
      reject(error);
    }
    return promise;
  }

  cancelPendingTurnCredentials() {
    const pending = this.pendingTurnCredentials;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingTurnCredentials = null;
    pending.reject(new Error('TURN資格の要求が取り消されました。'));
  }

  receiveTurnCredentials(message) {
    if (typeof message.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(message.requestId) ||
        !isValidTurnIceServers(message.iceServers)) {
      this.setStatus('シグナリングサーバーから不正なTURN資格を受け取りました。', true);
      return;
    }
    const pending = this.pendingTurnCredentials;
    if (this.localRole === 'host' && (!pending || pending.requestId !== message.requestId)) return;
    this.turnIceServers = message.iceServers;
    if (!pending || pending.requestId !== message.requestId) return;
    window.clearTimeout(pending.timer);
    this.pendingTurnCredentials = null;
    pending.resolve(message.iceServers);
  }

  receiveTurnError(message) {
    const pending = this.pendingTurnCredentials;
    if (pending && pending.requestId === message.requestId) {
      window.clearTimeout(pending.timer);
      this.pendingTurnCredentials = null;
      pending.reject(new Error(message.message || 'TURN資格を発行できませんでした。'));
    } else if (this.localRole === 'guest') {
      this.setStatus(`TURNを利用できないためSTUN直接接続を試します: ${message.message || '資格を発行できませんでした。'}`, true);
    }
  }

  async receiveJoinRequest(message) {
    if (this.pendingGuest || this.peerConnection || this.getRecordingState()) {
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
    $('guestRequestCard').hidden = false;
    $('approveGuestButton').hidden = false;
    $('denyGuestButton').hidden = false;
    this.setStatus('ゲストから申請が届きました。下の申請カードで名前を確認してください。');
    this.setCallState('参加申請を確認してください');
    this.setRemoteWaveState('承認待ち');
  }

  async approveGuest() {
    if (!this.pendingGuest || !this.room || !this.hostKeys) return;
    if (this.getRecordingState()) {
      this.setStatus('録音を停止して保存してからゲストを接続してください。', true);
      return;
    }
    $('approveGuestButton').disabled = true;
    $('denyGuestButton').disabled = true;
    try {
      this.send({ type: 'approved' });
      try {
        await this.requestTurnCredentials();
      } catch (error) {
        if (this.localRole !== 'host' || !this.pendingGuest) return;
        this.turnIceServers = null;
        this.setStatus(`TURNを利用できないためSTUN直接接続を試します: ${error.message}`, true);
      }
      if (this.localRole !== 'host' || !this.pendingGuest) return;
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
    this.recordingTransfer.setRole(this.localRole);
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.turnIceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
    if (this.localRole === 'host') {
      const channel = this.peerConnection.createDataChannel('master-transfer-v1', { ordered: true });
      this.recordingTransfer.setChannel(channel);
    } else {
      this.peerConnection.addEventListener('datachannel', ({ channel }) => {
        if (channel.label !== 'master-transfer-v1' || !channel.ordered ||
            channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
          channel.close();
          this.setStatus('信頼性のない音源回収DataChannelを拒否しました。', true);
          return;
        }
        this.recordingTransfer.setChannel(channel);
      });
    }
    this.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate && this.socket?.readyState === WebSocket.OPEN) {
        this.send({ type: 'candidate', candidate: candidate.toJSON() });
      }
    });
    this.peerConnection.addEventListener('track', (event) => {
      const audio = $('remoteAudio');
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      const participantName = this.localRole === 'host'
        ? (this.pendingGuest?.name || 'ゲスト')
        : 'ホスト';
      void this.startRemoteWaveform(event.track, participantName).catch((error) => {
        this.setStatus(`相手の波形を表示できませんでした: ${error.message}`, true);
      });
      event.track.addEventListener('unmute', () => { void this.playRemoteAudio(); });
      event.track.addEventListener('mute', () => {
        $('playRemoteAudioButton').hidden = true;
        this.setRemoteWaveState('音声停止', false, event.track.id);
        this.setCallState('相手の音声が一時中断しています。相手のマイク状態を確認してください。');
      });
      event.track.addEventListener('ended', () => {
        $('playRemoteAudioButton').hidden = true;
        this.stopRemoteWaveform(event.track.id);
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
      this.updateReadinessUI();
      if (state === 'connected') {
        window.clearTimeout(this.disconnectTimer);
        this.retryCount = 0;
        if (this.connected && this.authFields) this.recordingTransfer.refreshInventory();
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
    this.previousTransferStats = null;
    this.transferSendMbps = null;
    $('connectionStats').hidden = false;
    $('connectionStats').textContent = '接続統計を取得しています…';
    void this.updateConnectionStats();
    this.statsTimer = window.setInterval(() => { void this.updateConnectionStats(); }, 2000);
  }

  stopConnectionStats(message) {
    window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.previousStats = null;
    this.previousTransferStats = null;
    this.transferSendMbps = null;
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
      const pair = findSelectedIceCandidatePair(reports);
      const inbound = reportList.find((report) =>
        report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') && !report.isRemote
      );
      const outbound = reportList.find((report) =>
        report.type === 'outbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') && !report.isRemote
      );
      const dataChannel = reportList.find((report) =>
        report.type === 'data-channel' && report.label === 'master-transfer-v1'
      );
      const previousTransfer = this.previousTransferStats;
      this.transferSendMbps = previousTransfer && dataChannel &&
        previousTransfer.id === dataChannel.id &&
        dataChannel.timestamp > previousTransfer.timestamp &&
        Number.isFinite(dataChannel.bytesSent) &&
        dataChannel.bytesSent >= previousTransfer.bytesSent
        ? (dataChannel.bytesSent - previousTransfer.bytesSent) * 8 /
          (dataChannel.timestamp - previousTransfer.timestamp) / 1_000
        : null;
      this.previousTransferStats = dataChannel &&
        Number.isFinite(dataChannel.timestamp) && Number.isFinite(dataChannel.bytesSent)
        ? { id: dataChannel.id, timestamp: dataChannel.timestamp, bytesSent: dataChannel.bytesSent }
        : null;
      const currentStats = {
        timestamp: outbound?.timestamp ?? inbound?.timestamp ?? performance.now(),
        outboundId: outbound?.id ?? null,
        inboundId: inbound?.id ?? null,
        bytesSent: outbound?.bytesSent,
        packetsReceived: inbound?.packetsReceived,
        packetsLost: inbound?.packetsLost,
        concealedSamples: inbound?.concealedSamples
      };
      const previous = this.previousStats;
      const sameReports = previous &&
        (!outbound || !previous.outboundId || previous.outboundId === outbound.id) &&
        (!inbound || !previous.inboundId || previous.inboundId === inbound.id);
      const intervalStats = calculateIntervalStats(
        sameReports ? previous : null,
        currentStats,
        sameReports ? currentStats.timestamp - previous.timestamp : 0
      );
      this.previousStats = outbound || inbound ? currentStats : null;

      const parts = [];
      if (pair?.currentRoundTripTime !== undefined) {
        parts.push(`RTT ${Math.round(pair.currentRoundTripTime * 1000)} ms`);
      }
      if (inbound?.jitter !== undefined) parts.push(`jitter ${Math.round(inbound.jitter * 1000)} ms`);
      if (intervalStats.packetLossPercent !== null) {
        parts.push(`損失 ${intervalStats.packetLossPercent.toFixed(1)}%`);
      }
      if (intervalStats.concealedSamples !== null) {
        parts.push(`補間 ${intervalStats.concealedSamples} samples`);
      }
      if (intervalStats.bitrateKbps !== null) {
        parts.push(`送信 ${Math.round(intervalStats.bitrateKbps)} kbps`);
      }
      if (pair) {
        const local = reports.get(pair.localCandidateId)?.candidateType;
        const remote = reports.get(pair.remoteCandidateId)?.candidateType;
        if (local || remote) parts.push(`経路 ${local || '?'} → ${remote || '?'}`);
      } else if (reportList.some((report) => report.type === 'candidate-pair')) {
        parts.push('選択ICE経路を取得できません');
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
    this.transferProgressSequence = 0;
    this.lastTransferProgressSentAt = 0;
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
    this.remoteTransferProgress = null;
    const signature = await sign(this.hostKeys.privateKey, transcript(this.authFields));
    this.send({ type: 'auth-confirm', auth: { ...this.authFields, signature } });
    await this.attachLocalAudio();
    this.connected = true;
    this.recordingTransfer.wake();
    this.setStatus('参加者の署名とDTLS fingerprintを確認しました。');
    this.setCallState('通話を接続しています…');
    await this.checkLocalReadiness();
    if (this.getRecordingState()) {
      await this.onRecordingState?.(false);
      this.setStatus('接続前からの録音を停止しました。双方の準備完了後に新しいtakeを開始してください。', true);
    }
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
    this.recordingTransfer.wake();
    this.setStatus('ホストと双方の署名・DTLS fingerprintを確認しました。');
    this.setCallState('通話を接続しています…');
    await this.checkLocalReadiness();
    await this.applyPendingGuestRecordingCommand();
  }

  receiveReadyState(message) {
    if (!this.connected || !this.authFields || message.generation !== this.authFields.generation ||
        !Number.isSafeInteger(message.sequence) || message.sequence <= this.remoteReadySequence ||
        typeof message.ready !== 'boolean') return;
    this.remoteReadySequence = message.sequence;
    this.remoteReady = message.ready;
    this.updateReadinessUI();
    if (!message.ready) this.setStatus('相手の録音準備が完了していません。相手側の表示を確認してください。', true);
    else if (this.localReady) this.setStatus('双方の録音準備が完了しました。');
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

  async attachLocalAudio(replacementStream = null) {
    if (replacementStream && (!this.connected || !this.authFields)) {
      throw new Error('認証済みの通話がありません。');
    }
    if (!this.localSender) throw new Error('送信用オーディオトラックがありません。');
    const stream = replacementStream ?? await this.getMicrophoneStream();
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
    for (const waveform of this.remoteWaveforms.values()) {
      if (waveform.audioContext?.state === 'suspended') {
        void waveform.audioContext.resume().catch((error) => {
          this.setRemoteWaveState('波形停止', false, waveform.id);
          this.setCallState(`相手の音声は接続中ですが、波形表示を開始できません: ${error.message}`);
        });
      }
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
    this.clearPendingClockProbes();
    this.clearPendingStartEvents();
    this.clockOffsetMs = null;
    const previousRole = this.localRole;
    const wasConnected = this.connected;
    this.recordingTransfer.close();
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
    this.localReady = false;
    this.remoteReady = false;
    this.readySequence = 0;
    this.remoteReadySequence = 0;
    $('remoteAudio').srcObject = null;
    this.stopRemoteWaveform();
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
    this.updateReadinessUI();
    if (!keepMessage) {
      const message = previousRole === 'guest' && !wasConnected
        ? '参加申請を取り消しました。'
        : previousRole === 'host' && !wasConnected
          ? '招待を終了しました。'
          : '通話を終了しました。ローカル録音データはこの端末に残っています。';
      this.setStatus(message);
    }
  }

  async requestLeave() {
    if (this.localRole === 'guest' && this.hasPendingTransfer) {
      try {
        if (await this.hasPendingTransfer(this.authFields?.generation) &&
            !window.confirm('ホスト保存を確認できていない音源があります。退出すると音源はこの端末にだけ残り、録音中転送は停止します。退出しますか？')) {
          return;
        }
      } catch (error) {
        this.setStatus(`ホスト保存状態を確認できませんでした: ${error.message}`, true);
        if (!window.confirm('ホスト保存状態が不明です。ローカル音源だけが残る可能性があります。それでも退出しますか？')) {
          return;
        }
      }
    }
    await this.leave();
  }

  resetRoomState() {
    this.room = null;
    this.hostKeys = null;
    this.localRole = null;
    this.pendingGuest = null;
    this.localReady = false;
    this.remoteReady = false;
    this.readySequence = 0;
    this.remoteReadySequence = 0;
    $('inviteField').hidden = true;
    $('leaveRoomButton').hidden = true;
    $('createRoomButton').hidden = false;
    this.updateReadinessUI();
  }
}
