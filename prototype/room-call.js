import { calculateIntervalStats } from './connection-stats.js';
import { calculateClockSample, selectClockSample } from './clock-sync.js';
import { RecordingTransfer } from './recording-transfer.js';
import { appendAlignedWaveformPeak, resetWaveformHistory } from './waveform-history.js';

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
  if (!match) throw new Error('Unable to get the WebRTC DTLS fingerprint.');
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

function networkMessageSummary(message) {
  if (!message || typeof message !== 'object') return 'invalid message';
  const type = typeof message.type === 'string' && /^[a-z0-9-]{1,60}$/iu.test(message.type)
    ? message.type
    : 'unknown';
  const fields = [];
  for (const key of [
    'role', 'eventId', 'sequence', 'recording', 'ready', 'accepted', 'muted', 'level', 'startAt',
    'hostStartedAt', 'clockOffsetMs', 'observedAt', 'frame', 'probeId',
    'sentAt', 'receivedAt', 'takeId', 'startFrame', 'frames', 'totalBytes',
    'count', 'startedAt', 'takeNumber', 'chunks'
  ]) {
    const value = message[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      fields.push(`${key}=${value}`);
    } else if (typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.-]+$/u.test(value)) {
      fields.push(`${key}=${value}`);
    }
  }
  if (typeof message.sdp === 'string') fields.push(`sdpBytes=${new TextEncoder().encode(message.sdp).byteLength}`);
  if (message.type === 'candidate' && typeof message.candidate?.candidate === 'string') {
    const match = message.candidate.candidate.match(/\s(udp|tcp)\s+\d+\s+\S+\s+\d+\s+typ\s+(host|srflx|prflx|relay)\b/iu);
    fields.push(`candidate=${match ? `${match[2]}/${match[1]}` : 'unknown'}`);
  }
  return [`type=${type}`, ...fields].join(' ');
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
    onSessionName,
    onNetworkEvent,
    prepareRecordingAudioContext,
    releasePreparedRecordingAudioContext,
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
    this.onSessionName = onSessionName;
    this.onNetworkEvent = onNetworkEvent;
    this.prepareRecordingAudioContext = prepareRecordingAudioContext;
    this.releasePreparedRecordingAudioContext = releasePreparedRecordingAudioContext;
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
        if (!markTransferChunkStored) throw new Error('Unable to save the receipt acknowledgment to the local ledger.');
        return markTransferChunkStored(...args);
      },
      getNextManifest: () => getNextTransferManifest
        ? getNextTransferManifest(this.authFields?.generation)
        : null,
      prepareChunk: (...args) => {
        if (!prepareTransferChunk) throw new Error('Unable to save the pre-transfer hash to the local ledger.');
        return prepareTransferChunk(...args);
      },
      getTransferInventory: (...args) => {
        if (!getTransferInventory) throw new Error('Unable to read the transfer inventory.');
        return getTransferInventory(...args);
      },
      reconcileTransferInventory: (...args) => {
        if (!reconcileTransferInventory) throw new Error('Unable to reconcile the transfer inventory.');
        return reconcileTransferInventory(...args);
      },
      markManifestStored: (...args) => {
        if (!markTransferManifestStored) throw new Error('Unable to save the final acknowledgment to the local ledger.');
        return markTransferManifestStored(...args);
      },
      storeChunk: (...args) => {
        if (!storeIncomingTransferChunk) throw new Error('No destination is available for received audio.');
        return storeIncomingTransferChunk(...args);
      },
      storeManifest: (...args) => {
        if (!storeIncomingTransferManifest) throw new Error('No destination is available for the received manifest.');
        return storeIncomingTransferManifest(...args);
      },
      onStatus: (message, isError = false) => {
        if (isError) this.logNetworkEvent('Transfer error', message);
        this.setStatus(message, isError);
      }
    });
    this.socket = null;
    this.peerConnection = null;
    this.localRole = null;
    this.room = null;
    this.hostKeys = null;
    this.guestIdentity = null;
    this.guestNonce = null;
    this.pendingGuest = null;
    this.sessionName = null;
    this.remoteSessionName = null;
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
    this.inputMonitorChannel = null;
    this.lastInputMonitorSentAt = -Infinity;
    this.lastInputMonitorSentState = null;
    this.localInputMonitorState = { level: 0, muted: false, deviceLabel: '' };
    this.remoteInputMonitorState = { level: 0, muted: null, deviceLabel: '' };
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
      throw new Error('Both devices must be ready and connected before clock synchronization.');
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
    if (!this.isPeerReadyForRecording) throw new Error('The call connection was lost during clock synchronization.');
    const selected = selectClockSample(samples, MIN_CLOCK_PROBE_SAMPLES);
    this.clockOffsetMs = selected.offsetMs;
    this.logNetworkEvent(
      'Clock sync selected',
      `offset=${selected.offsetMs.toFixed(2)} ms RTT=${selected.roundTripMs.toFixed(2)} ms samples=${samples.length}`
    );
    this.setStatus(`Start time synchronized (RTT ${Math.round(selected.roundTripMs)} ms).`);
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
      this.setStatus(`Unable to send the clock synchronization response: ${error.message}`, true);
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
      const sample = calculateClockSample(
        probe.sentAt,
        message.receivedAt,
        message.repliedAt,
        performance.now()
      );
      this.logNetworkEvent(
        'Clock sync sample',
        `probe=${message.probeId} offset=${sample.offsetMs.toFixed(2)} ms RTT=${sample.roundTripMs.toFixed(2)} ms`
      );
      probe.resolve(sample);
    } catch {
      probe.resolve(null);
    }
  }

  notifyLocalRecordingStarted(event, observedAt, frame) {
    if (!event || frame !== 0) return;
    const pending = this.pendingStartEvents.get(event.eventId);
    if (!pending || pending.sequence !== event.sequence) return;
    this.logNetworkEvent(
      'Recording start local',
      `event=${event.eventId} frame=${frame} observedAt=${observedAt.toFixed(3)} ms target=${pending.startAt.toFixed(3)} ms`
    );
    pending.localStartedAt = observedAt;
    this.completeStartEvent(pending);
  }

  notifyRecordingStarted(event, observedAt, frame) {
    if (!event || this.localRole !== 'guest' || frame !== 0 || !this.authFields) return;
    this.logNetworkEvent(
      'Recording start local',
      `event=${event.eventId} frame=${frame} observedAt=${observedAt.toFixed(3)} ms`
    );
    try {
      this.send({
        type: 'recording-started',
        eventId: event.eventId,
        sequence: event.sequence,
        generation: this.authFields.generation,
        observedAt,
        frame
      });
      this.logNetworkEvent(
        'Recording start confirmation sent',
        `event=${event.eventId} sequence=${event.sequence} observedAt=${observedAt.toFixed(3)} ms`
      );
    } catch (error) {
      this.logNetworkEvent('Recording start confirmation failed', error.message);
      this.setStatus(`Unable to send the recording start confirmation to the host: ${error.message}`, true);
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
    if (this.localRole !== 'host') return;
    if (message.generation !== this.authFields?.generation) {
      this.logNetworkEvent('Recording start confirmation ignored', 'generation mismatch');
      return;
    }
    const pending = this.pendingStartEvents.get(message.eventId);
    if (!pending) {
      this.logNetworkEvent(
        'Recording start confirmation ignored',
        `event=${message.eventId} no pending start event (timed out, canceled, or already completed)`
      );
      return;
    }
    if (pending.sequence !== message.sequence) {
      this.logNetworkEvent(
        'Recording start confirmation ignored',
        `event=${message.eventId} sequence mismatch expected=${pending.sequence} received=${message.sequence}`
      );
      return;
    }
    if (message.frame !== 0 || !Number.isFinite(message.observedAt)) {
      this.logNetworkEvent(
        'Recording start confirmation ignored',
        `event=${message.eventId} invalid frame or observedAt`
      );
      return;
    }
    pending.remoteStartedAt = message.observedAt - pending.clockOffsetMs;
    this.logNetworkEvent(
      'Recording start remote',
      `event=${message.eventId} guestObservedAt=${message.observedAt.toFixed(3)} ms hostClock=${pending.remoteStartedAt.toFixed(3)} ms offset=${pending.clockOffsetMs.toFixed(3)} ms`
    );
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
      this.setStatus(`Unable to report the guest audio recovery status: ${error.message}`, true);
    }
  }

  receiveTransferProgress(message) {
    if (this.localRole !== 'host' || !this.connected ||
        message.generation !== this.authFields?.generation ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= (this.remoteTransferProgress?.sequence || 0)) return;
    this.remoteTransferProgress = { ...message, receivedAt: performance.now() };
  }

  async receiveSessionName(message) {
    if (typeof message.name !== 'string' || !message.name.trim() || message.name.trim().length > 120) {
      throw new Error('The host sent an invalid session name.');
    }
    this.remoteSessionName = message.name.trim();
    await this.onSessionName?.(this.remoteSessionName);
  }

  completeStartEvent(pending) {
    if (pending.localStartedAt === null || pending.remoteStartedAt === null) return;
    window.clearTimeout(pending.timer);
    this.pendingStartEvents.delete(pending.eventId);
    const driftMs = pending.remoteStartedAt - pending.localStartedAt;
    this.logNetworkEvent(
      'Recording start comparison',
      `event=${pending.eventId} host=${pending.localStartedAt.toFixed(3)} ms guest=${pending.remoteStartedAt.toFixed(3)} ms difference=${driftMs.toFixed(3)} ms`
    );
    const warning = Math.abs(driftMs) > 20;
    this.setStatus(
      `Recording start confirmed on both devices (difference ${Math.round(driftMs)} ms${warning ? ' · above 20 ms target' : ''}).`,
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
      this.setStatus('The invitation link is invalid. Ask the host for a new link.', true);
      return null;
    }
    try {
      if (fromBase64Url(secret).length !== 32 || fromBase64Url(hostPublicKey).length < 64) throw new Error();
    } catch {
      this.setStatus('The invitation link is invalid. Ask the host for a new link.', true);
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
    $('participantNameLabel').textContent = guestMode ? 'Name shown to the host' : 'Your name';
    $('micDeviceLabel').textContent = guestMode ? 'Microphone for calls and recording' : 'Recording microphone';
    $('openStudioButton').textContent = guestMode ? 'Continue to Guest Studio' : 'Open Studio';
    $('openStudioButton').disabled = guestMode && !this.invitation;
    $('recentPanel').hidden = false;
    $('setupView').querySelector('.setup-grid').classList.toggle('guest-mode', guestMode);
    $('roomPanel').classList.toggle('guest-mode', guestMode);
    $('roleBadge').textContent = guestMode ? 'Guest' : 'Host';
    $('roleBadge').classList.toggle('guest', guestMode);
    $('roomRoleLabel').textContent = guestMode ? 'Guest controls' : 'Host controls';
    $('roomHeading').textContent = guestMode ? 'Join the invited room' : 'Invite a guest';
    $('createRoomButton').hidden = guestMode;
    $('joinRoomButton').hidden = !guestMode || !this.invitation;
    $('joinRoomButton').disabled = guestMode && !this.invitation;
    $('recordControls').hidden = guestMode;
    $('hostRecordingNotice').hidden = !guestMode;
    $('transferProgressHeading').textContent = guestMode
      ? 'Audio transfer to host'
      : 'Guest audio reception status';
    $('joinRoomButton').textContent = 'Request to Join Host';
    this.setRemoteWaveState('Not connected');
    if (guestMode && !this.invitation) {
      $('statusMessage').textContent = 'The invitation link is invalid. Ask the host for a new link.';
    } else if (guestMode) {
      this.setStatus('Invitation verified. Request to join the host when you are ready.');
    } else {
      this.setStatus('Create an invitation link to invite a guest.');
    }
  }

  setStatus(message, isError = false) {
    const status = $('roomStatus');
    if (status) {
      status.textContent = message;
      status.classList.toggle('room-error', isError);
    }
  }

  logNetworkEvent(event, details = '') {
    this.onNetworkEvent?.(event, details);
  }

  setCallState(message) {
    $('callState').textContent = message;
  }

  sendInputMonitorState(level, muted, deviceLabel) {
    this.localInputMonitorState = {
      level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0,
      muted: Boolean(muted),
      deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.slice(0, 120) : ''
    };
    const channel = this.inputMonitorChannel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 4096) return;
    const stateChanged = !this.lastInputMonitorSentState ||
      this.lastInputMonitorSentState.muted !== this.localInputMonitorState.muted ||
      this.lastInputMonitorSentState.deviceLabel !== this.localInputMonitorState.deviceLabel;
    if (!stateChanged && performance.now() - this.lastInputMonitorSentAt < 100) return;
    channel.send(JSON.stringify({ type: 'input-state', ...this.localInputMonitorState }));
    this.lastInputMonitorSentAt = performance.now();
    this.lastInputMonitorSentState = {
      muted: this.localInputMonitorState.muted,
      deviceLabel: this.localInputMonitorState.deviceLabel
    };
  }

  setInputMonitorChannel(channel) {
    this.inputMonitorChannel = channel;
    channel.addEventListener('open', () => {
      if (this.inputMonitorChannel !== channel) return;
      this.lastInputMonitorSentAt = -Infinity;
      this.lastInputMonitorSentState = null;
      this.sendInputMonitorState(
        this.localInputMonitorState.level,
        this.localInputMonitorState.muted,
        this.localInputMonitorState.deviceLabel
      );
    });
    channel.addEventListener('message', ({ data }) => this.receiveInputMonitorMessage(data));
    channel.addEventListener('close', () => {
      if (this.inputMonitorChannel !== channel) return;
      this.inputMonitorChannel = null;
      this.lastInputMonitorSentAt = -Infinity;
      this.lastInputMonitorSentState = null;
      this.updateRemoteInputMonitor({ level: 0, muted: null, deviceLabel: '' });
    });
    channel.addEventListener('error', () => {
      if (this.inputMonitorChannel === channel) {
        this.setStatus('Unable to synchronize the other participant’s microphone input level.', true);
      }
    });
    if (channel.readyState === 'open') {
      this.lastInputMonitorSentAt = -Infinity;
      this.lastInputMonitorSentState = null;
      this.sendInputMonitorState(
        this.localInputMonitorState.level,
        this.localInputMonitorState.muted,
        this.localInputMonitorState.deviceLabel
      );
    }
  }

  receiveInputMonitorMessage(data) {
    if (typeof data !== 'string' || data.length > 512) {
      this.setStatus('The other participant’s microphone information is invalid.', true);
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.setStatus(`Unable to read the other participant’s microphone information: ${error.message}`, true);
      return;
    }
    if (!message || message.type !== 'input-state' ||
        !Number.isFinite(message.level) || message.level < 0 || message.level > 1 ||
        typeof message.muted !== 'boolean' ||
        typeof message.deviceLabel !== 'string' || message.deviceLabel.length > 120) {
      this.setStatus('The other participant’s microphone information is invalid.', true);
      return;
    }
    this.updateRemoteInputMonitor({
      level: message.level,
      muted: message.muted,
      deviceLabel: message.deviceLabel
    });
  }

  updateRemoteInputMonitor(state) {
    this.remoteInputMonitorState = state;
    for (const waveform of this.remoteWaveforms.values()) {
      const peak = state.muted ? 0 : state.level;
      const db = peak > 0.0001 ? 20 * Math.log10(peak) : -Infinity;
      const percent = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
      waveform.meterFill.style.height = `${percent}%`;
      waveform.meterFill.className =
        `meter-fill remote-waveform-meter-fill${peak >= 0.999 ? ' clipping' : db >= -6 ? ' near-clip' : db >= -40 ? ' good' : ''}`;
      waveform.meter.setAttribute('aria-valuenow', String(Math.round(percent)));
      const deviceLabel = `${state.deviceLabel || 'Waiting for information'}${state.muted ? ' · MUTE' : ''}`;
      const option = waveform.device.options[0];
      if (option && option.textContent !== deviceLabel) option.textContent = deviceLabel;
      if (waveform.muteState) {
        const muteState = state.muted === null ? 'wait' : state.muted ? 'muted' : 'unmuted';
        waveform.muteState.textContent =
          muteState === 'wait' ? '' : muteState === 'muted' ? 'MUTED' : 'UNMUTED';
        waveform.muteState.classList.toggle('muted', muteState === 'muted');
        waveform.muteState.classList.toggle('unmuted', muteState === 'unmuted');
        waveform.muteState.classList.toggle('wait', muteState === 'wait');
        waveform.muteState.setAttribute('aria-label',
          muteState === 'wait'
            ? 'Checking the other participant’s mute status'
            : muteState === 'muted' ? 'The other participant is muted' : 'The other participant is not muted');
      }
    }
  }

  updateReadinessUI() {
    const connected = this.connected && this.socket?.readyState === WebSocket.OPEN &&
      this.peerConnection?.connectionState === 'connected';
    const waitingForGuest = this.localRole === 'host' && !this.pendingGuest && !this.peerConnection;
    $('checkReadinessButton').hidden = !connected;
    $('retryTransferButton').hidden = !connected;
    $('retryTransferButton').textContent = this.localRole === 'host'
      ? 'Check Reception Status'
      : 'Retry Transfer';
    $('recordingReadiness').textContent = waitingForGuest
      ? 'Guest not connected · You can start recording alone'
      : !connected
        ? 'Recording readiness has not been checked'
        : !this.localReady
          ? 'This device is not ready to record'
          : !this.remoteReady
            ? 'This device is ready · Waiting for the other participant'
            : 'Both devices are ready to record';
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
      if (readinessError) this.setStatus(`Unable to verify recording readiness on this device: ${readinessError.message}`, true);
      else if (!this.localReady) this.setStatus('This device is not ready to record. Check the microphone and available storage.', true);
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
        this.setStatus(`Unable to notify the other participant of recording readiness: ${error.message}`, true);
      }
      this.updateReadinessUI();
      if (this.localReady && this.remoteReady) this.setStatus('Both devices are ready to record.');
      else if (this.localReady) this.setStatus('This device is ready to record. Waiting for the other participant.');
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
      ? 'Reconciling the ledger for audio saved on the host.'
      : 'Rechecking unconfirmed audio and the ledger saved on the host.');
  }

  setHostRecordingState(recording, startAt = null, clockOffsetMs = null, eventId = crypto.randomUUID(), hostStartedAt = null) {
    if (this.localRole !== 'host') return null;
    if (typeof recording !== 'boolean') {
      this.setStatus('Unable to synchronize recording status with the guest.', true);
      return null;
    }
    if (!this.connected) return null;
    if (recording && !this.canStartRecording) {
      this.setStatus('Verify that both devices are ready to record and connected before starting.', true);
      if (this.getRecordingState()) void this.onRecordingState?.(false);
      return null;
    }
    if (recording && (!Number.isFinite(startAt) || startAt <= performance.now() ||
        !Number.isFinite(clockOffsetMs) || Math.abs(clockOffsetMs) > 60_000 ||
        !Number.isFinite(startAt + clockOffsetMs) ||
        (hostStartedAt !== null && (!Number.isFinite(hostStartedAt) || hostStartedAt <= 0)))) {
      this.setStatus('There is no valid synchronized start time. Synchronize the clocks again.', true);
      if (this.getRecordingState()) void this.onRecordingState?.(false);
      return null;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus('Unable to synchronize recording status because the guest is not connected.', true);
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
      clockOffsetMs,
      hostStartedAt
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
        this.setStatus('No recording start confirmation was received from the participant. Recording continues. Check the recording status on both devices.', true);
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
        if (Number.isFinite(pending.hostStartedAt)) message.hostStartedAt = pending.hostStartedAt;
      }
      this.send(message);
      if (!pending.recording) {
        this.logNetworkEvent(
          'Recording stop command sent',
          `event=${pending.eventId} sequence=${pending.sequence}`
        );
      }
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
        this.setStatus('No recording status acknowledgment was received from the guest. Check the recording status on both devices.', true);
        if (pending.recording) void this.onRecordingState?.(false);
      }, 5000);
    } catch (error) {
      this.setStatus(`Unable to synchronize recording status with the guest: ${error.message}`, true);
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
      this.setStatus('Received invalid recording status from the host.', true);
      return;
    }
    if (message.recording && (!Number.isFinite(message.startAt) || message.startAt <= 0 ||
        !Number.isFinite(message.clockOffsetMs) || Math.abs(message.clockOffsetMs) > 60_000 ||
        !Number.isFinite(message.startAt + message.clockOffsetMs) ||
        (message.hostStartedAt !== undefined &&
          (!Number.isFinite(message.hostStartedAt) || message.hostStartedAt <= 0)))) {
      this.setStatus('Rejected a recording start instruction with an invalid start time.', true);
      return;
    }
    const prior = this.guestRecordingCommands.get(message.eventId);
    if (prior) {
      if (prior.recording !== message.recording || prior.sequence !== message.sequence ||
          prior.generation !== message.generation ||
          prior.startAt !== (message.recording ? message.startAt + message.clockOffsetMs : null) ||
          prior.clockOffsetMs !== (message.recording ? message.clockOffsetMs : null) ||
          (prior.hostStartedAt ?? null) !== (message.recording ? message.hostStartedAt ?? null : null)) {
        this.setStatus('Conflicting states were received for the same recording event ID.', true);
        return;
      }
      await prior.resultPromise;
      this.sendRecordingAck(prior);
      return;
    }
    if (message.recording && message.startAt + message.clockOffsetMs < performance.now() + 250) {
      this.setStatus('Rejected a recording start instruction received after its scheduled start time.', true);
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
      this.setStatus('Ignored an outdated recording status event.', true);
      return;
    }
    this.lastGuestRecordingSequence = message.sequence;
    this.remoteRecordingState = message.recording;
    if (!message.recording) {
      this.logNetworkEvent(
        'Recording stop command received',
        `event=${message.eventId} sequence=${message.sequence}`
      );
    }
    const command = {
      eventId: message.eventId,
      sequence: message.sequence,
      generation: message.generation,
      recording: message.recording,
      startAt: message.recording ? message.startAt + message.clockOffsetMs : null,
      clockOffsetMs: message.recording ? message.clockOffsetMs : null,
      hostStartedAt: message.recording ? message.hostStartedAt ?? null : null,
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
        this.setStatus('Recording could not start because both devices are not ready and connected.', true);
        command.accepted = false;
        return;
      }
      const result = await this.onRecordingState?.(
        command.recording,
        command.recording
          ? {
            startAt: command.startAt,
            hostStartedAt: command.hostStartedAt,
            event: { eventId: command.eventId, sequence: command.sequence }
          }
          : null
      );
      command.accepted = result !== false;
    }).catch((error) => {
      this.setStatus(`Unable to apply the host recording status: ${error.message}`, true);
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
      this.setStatus(`Unable to send the recording status acknowledgment: ${error.message}`, true);
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
      this.setStatus(message.recording ? 'The guest’s scheduled recording start was confirmed.' : 'The guest’s recording stop and save were confirmed.');
      return;
    }

    if (pending.recording) {
      const startEvent = this.pendingStartEvents.get(message.eventId);
      if (startEvent) window.clearTimeout(startEvent.timer);
      this.pendingStartEvents.delete(message.eventId);
    }
    this.setStatus('The guest could not apply the recording status. Check the recording status on both devices.', true);
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
      waveform.state.textContent = /^(?:Waiting\b|Awaiting\b)/i.test(message) ? '' : message;
      waveform.state.classList.toggle('remote-live', active);
    }
  }

  async startRemoteWaveform(track, participantName) {
    if (!window.AudioContext) throw new Error('Waveform display is not available in this browser.');
    this.stopRemoteWaveform(track.id);

    const element = $('remoteWaveformTemplate').content.firstElementChild.cloneNode(true);
    const waveformStartedAt = this.waveformRecordingStartedAt;
    const now = performance.now();
    const waveform = {
      id: track.id,
      element,
      track,
      canvas: element.querySelector('.remote-waveform-canvas'),
      meter: element.querySelector('.remote-waveform-meter'),
      meterFill: element.querySelector('.remote-waveform-meter-fill'),
      device: element.querySelector('.remote-waveform-device'),
      muteState: element.querySelector('.remote-mute-state'),
      state: element.querySelector('.remote-waveform-state'),
      labels: element.querySelectorAll('.waveform-timeline span'),
      audioContext: null,
      source: null,
      analyser: null,
      silentGain: null,
      samples: null,
      history: new Float32Array(600),
      historyCount: 0,
      lastSampleIndex: -1,
      recordingStartedAt: null,
      animationFrame: null,
      sampledAt: now,
      startedAt: now,
      rulerSecond: -1
    };
    resetWaveformHistory(waveform, waveformStartedAt, now);
    element.querySelector('.remote-waveform-participant').textContent = participantName;
    waveform.canvas.setAttribute('aria-label', `${participantName} microphone input waveform`);
    $('remoteWaveformTracks').append(element);
    this.remoteWaveforms.set(waveform.id, waveform);
    this.updateRemoteInputMonitor(this.remoteInputMonitorState);

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
      this.setRemoteWaveState(
        track.muted ? 'Waiting for audio' : waveformStartedAt === null ? 'Waiting to record' : 'Preparing waveform',
        false,
        track.id
      );
      if (waveformStartedAt !== null) this.drawRemoteWaveform(waveform);
      if (waveform.audioContext.state === 'suspended') {
        void waveform.audioContext.resume().catch((error) => {
          this.setRemoteWaveState('Waveform stopped', false, track.id);
          this.setCallState(`The other participant’s audio is connected, but the waveform could not start: ${error.message}`);
        });
      }
    } catch (error) {
      this.stopRemoteWaveform(track.id);
      throw error;
    }
  }

  beginRecordingWaveform(startedAt) {
    if (!Number.isFinite(startedAt)) throw new Error('The waveform recording start time is invalid.');
    this.waveformRecordingStartedAt = startedAt;
    for (const waveform of this.remoteWaveforms.values()) {
      resetWaveformHistory(waveform, startedAt, startedAt);
      this.setRemoteWaveState(waveform.track.muted ? 'Waiting for audio' : 'Preparing waveform', false, waveform.id);
      this.drawRemoteWaveform(waveform);
    }
  }

  endRecordingWaveform() {
    this.waveformRecordingStartedAt = null;
    for (const waveform of this.remoteWaveforms.values()) {
      if (waveform.animationFrame !== null) window.cancelAnimationFrame(waveform.animationFrame);
      waveform.animationFrame = null;
      resetWaveformHistory(waveform, null);
      const context = waveform.canvas.getContext('2d');
      if (context) context.clearRect(0, 0, waveform.canvas.width, waveform.canvas.height);
      this.setRemoteWaveState(waveform.track.muted ? 'Waiting for audio' : 'Waiting to record', false, waveform.id);
    }
  }

  drawRemoteWaveform(waveform) {
    waveform.animationFrame = null;
    if (this.remoteWaveforms.get(waveform.id) !== waveform ||
        this.waveformRecordingStartedAt === null || waveform.recordingStartedAt === null) return;
    const canvas = waveform.canvas;
    const context = canvas.getContext('2d');
    if (!context || !canvas.parentElement) {
      this.setRemoteWaveState('Waveform rendering error', false, waveform.id);
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
      appendAlignedWaveformPeak(waveform, peak, now);
      waveform.sampledAt = now;
      this.setRemoteWaveState('LIVE', true, waveform.id);
    } else if (waveform.track.muted) {
      this.setRemoteWaveState('Waiting for audio', false, waveform.id);
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
    if (this.waveformRecordingStartedAt !== null) {
      waveform.animationFrame = window.requestAnimationFrame(() => this.drawRemoteWaveform(waveform));
    }
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
      this.setStatus('Open the studio first.', true);
      return;
    }
    if (this.getRecordingState()) {
      this.setStatus('Stop and save the recording before creating an invitation link.', true);
      return;
    }
    $('createRoomButton').disabled = true;
    this.setStatus('Preparing invitation…');
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
      this.setSessionName(this.getSession().name);
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
      $('leaveRoomButton').textContent = 'End Invitation';
      this.setStatus('Invitation created. Share the link with your guest.');
      this.setCallState('Waiting for the other participant to request access');
      this.setRemoteWaveState('Waiting for guest');
    } catch (error) {
      this.setStatus(`Unable to create invitation: ${error.message}`, true);
      this.resetRoomState();
    } finally {
      $('createRoomButton').disabled = false;
    }
  }

  async requestJoin() {
    if (!this.invitation || !this.getSession()) return;
    $('joinRoomButton').disabled = true;
    this.setStatus('Checking microphone and requesting to join…');
    try {
      this.prepareRecordingAudioContext?.();
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
      this.logNetworkEvent('Join request sent', `issuedAt=${issuedAt}`);
      this.setStatus('Join request sent. Waiting for the host to approve.');
      this.setCallState('Waiting for host approval');
      this.setRemoteWaveState('Awaiting approval');
      $('joinRoomButton').hidden = true;
      $('leaveRoomButton').hidden = false;
      $('leaveRoomButton').textContent = 'Cancel Join Request';
    } catch (error) {
      this.setStatus(`Unable to send join request: ${error.message}`, true);
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
        reject(new Error('The signaling connection timed out.'));
      }, 10000);
      socket.addEventListener('open', () => {
        this.logNetworkEvent('Signaling socket', 'open');
        socket.send(JSON.stringify({ type: 'join', role }));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          socket.close();
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            reject(new Error('Unable to read the signaling response.'));
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
          reject(new Error(message.message || 'Unable to join the room.'));
        }
        void this.handleMessage(message);
      });
      socket.addEventListener('error', () => {
        this.logNetworkEvent('Signaling socket', 'error');
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error('Unable to connect to the signaling server. Run the Worker over HTTPS.'));
      }, { once: true });
      socket.addEventListener('close', (event) => {
        this.logNetworkEvent('Signaling socket', `close code=${event.code} clean=${event.wasClean}`);
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error('The signaling server rejected the connection.'));
        } else if (this.socket === socket && this.localRole) {
          this.connected = false;
          this.localReady = false;
          this.remoteReady = false;
          this.remoteReadySequence = 0;
          this.setCallState('Connection lost. Recording data is saved on this device.');
          this.updateReadinessUI();
        }
      });
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('There is no signaling connection to the other participant.');
    }
    this.socket.send(JSON.stringify(message));
  }

  setSessionName(name) {
    if (this.isGuest || typeof name !== 'string') return;
    this.sessionName = name.trim();
    this.sendSessionName();
  }

  sendSessionName() {
    if (this.localRole !== 'host' || !this.sessionName || !this.pendingGuest || !this.peerConnection) return;
    try {
      this.send({ type: 'session-name', name: this.sessionName });
    } catch (error) {
      this.onError?.(error);
    }
  }

  handleMessage(message) {
    this.incomingMessageChain = this.incomingMessageChain.then(() => this.processMessage(message));
    return this.incomingMessageChain;
  }

  async processMessage(message) {
    try {
      if (message.type === 'rejected') {
        this.setStatus(message.message || 'Unable to join the room.', true);
        return;
      }
      if (message.type === 'join-request' && this.localRole === 'host') {
        await this.receiveJoinRequest(message);
      } else if (message.type === 'approved' && this.localRole === 'guest') {
        this.setStatus('The host approved your request. Connecting the call…');
        $('leaveRoomButton').textContent = 'End Call';
        this.setRemoteWaveState('Connecting');
      } else if (message.type === 'denied') {
        this.setStatus('The host declined your join request.', true);
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
      } else if (message.type === 'session-name' && this.localRole === 'guest') {
        await this.receiveSessionName(message);
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
        this.inputMonitorChannel?.close();
        this.inputMonitorChannel = null;
        this.remoteInputMonitorState = { level: 0, muted: null, deviceLabel: '' };
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
        this.setRemoteWaveState('Not connected');
        this.setCallState('The other participant left. Waiting for a new join request.');
        this.setStatus('The connection to the other participant has ended.');
        this.updateReadinessUI();
        $('leaveRoomButton').textContent = 'End Invitation';
      } else if (message.type === 'ice-restart' && this.localRole === 'guest') {
        await this.answerIceRestart(message);
      } else if (message.type === 'ice-restart-answer' && this.localRole === 'host') {
        await this.receiveIceRestartAnswer(message);
      }
    } catch (error) {
      this.setStatus(`Unable to establish the call: ${error.message}`, true);
      await this.leave({ keepMessage: true });
      this.onError?.(error);
    }
  }

  async requestTurnCredentials() {
    if (this.localRole !== 'host' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('There is no signaling connection to request TURN credentials.'));
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
        reject(new Error('The TURN credential request timed out.'));
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
    pending.reject(new Error('The TURN credential request was canceled.'));
  }

  receiveTurnCredentials(message) {
    if (typeof message.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(message.requestId) ||
        !isValidTurnIceServers(message.iceServers)) {
      this.setStatus('Received invalid TURN credentials from the signaling server.', true);
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
      pending.reject(new Error(message.message || 'Unable to issue TURN credentials.'));
    } else if (this.localRole === 'guest') {
      this.setStatus(`TURN is unavailable. Trying a direct STUN connection: ${message.message || 'Unable to issue credentials.'}`, true);
    }
  }

  async receiveJoinRequest(message) {
    this.logNetworkEvent('Join request received');
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
      if (!sameBytes(fromBase64Url(expected), fromBase64Url(message.proof))) throw new Error('The invitation credentials do not match.');
    } catch {
      this.send({ type: 'denied' });
      this.setStatus('Declined a join request because valid invitation credentials could not be verified.', true);
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
      this.setStatus('The room has reached its join request limit. Close this room and create a new invitation.');
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
    this.setStatus('A guest has requested to join. Review their name on the request card below.');
    this.setCallState('Review the join request');
    this.setRemoteWaveState('Awaiting approval');
  }

  async approveGuest() {
    if (!this.pendingGuest || !this.room || !this.hostKeys) return;
    if (this.getRecordingState()) {
      this.setStatus('Stop and save the recording before connecting a guest.', true);
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
        this.setStatus(`TURN is unavailable. Trying a direct STUN connection: ${error.message}`, true);
      }
      if (this.localRole !== 'host' || !this.pendingGuest) return;
      await this.createPeerConnection();
      this.sendSessionName();
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
      this.setStatus('Guest approved. Establishing a secure call connection.');
      this.setCallState('Connecting call…');
      this.setRemoteWaveState('Connecting');
      $('leaveRoomButton').textContent = 'End Call';
    } catch (error) {
      this.setStatus(`Unable to approve participant: ${error.message}`, true);
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
    this.setStatus('Join request declined.');
    this.setCallState('Request declined. Waiting for another request.');
    this.setRemoteWaveState('Waiting for guest');
  }

  observeDataChannel(channel, createdLocally = false) {
    const reliability = channel.ordered
      ? 'ordered'
      : `unordered maxRetransmits=${channel.maxRetransmits ?? 'default'} maxPacketLifeTime=${channel.maxPacketLifeTime ?? 'default'}`;
    this.logNetworkEvent(
      createdLocally ? 'DataChannel created' : 'DataChannel received',
      `${String(channel.label).slice(0, 64)} ${reliability}`
    );
    channel.addEventListener('open', () => {
      this.logNetworkEvent('DataChannel state', `${String(channel.label).slice(0, 64)} open`);
    });
    channel.addEventListener('close', () => {
      this.logNetworkEvent('DataChannel state', `${String(channel.label).slice(0, 64)} close`);
    });
    channel.addEventListener('error', () => {
      this.logNetworkEvent('DataChannel state', `${String(channel.label).slice(0, 64)} error`);
    });
  }

  async createPeerConnection() {
    if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC.');
    this.recordingTransfer.setRole(this.localRole);
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.turnIceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }]
    });
    this.logNetworkEvent(
      'PeerConnection created',
      `iceServers=${this.turnIceServers ? 'TURN' : 'STUN'}`
    );
    if (this.localRole === 'host') {
      const channel = this.peerConnection.createDataChannel('master-transfer-v1', { ordered: true });
      this.observeDataChannel(channel, true);
      this.recordingTransfer.setChannel(channel);
      const monitorChannel = this.peerConnection.createDataChannel(
        'input-monitor-v1',
        { ordered: false, maxRetransmits: 0 }
      );
      this.observeDataChannel(monitorChannel, true);
      this.setInputMonitorChannel(monitorChannel);
    } else {
      this.peerConnection.addEventListener('datachannel', ({ channel }) => {
        this.observeDataChannel(channel);
        if (channel.label === 'input-monitor-v1') {
          if (channel.ordered || channel.maxRetransmits !== 0 || channel.maxPacketLifeTime !== null) {
            channel.close();
            this.setStatus('Rejected the DataChannel for microphone level synchronization.', true);
            return;
          }
          this.setInputMonitorChannel(channel);
          return;
        }
        if (channel.label !== 'master-transfer-v1' || !channel.ordered ||
            channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
          channel.close();
          this.setStatus('Rejected the unreliable audio recovery DataChannel.', true);
          return;
        }
        this.recordingTransfer.setChannel(channel);
      });
    }
    this.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        this.logNetworkEvent('ICE candidate generated', networkMessageSummary({
          type: 'candidate',
          candidate: candidate.toJSON()
        }));
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.send({ type: 'candidate', candidate: candidate.toJSON() });
        } else {
          this.logNetworkEvent('ICE candidate not sent', 'signaling socket is not open');
        }
      } else if (!candidate) {
        this.logNetworkEvent('ICE gathering', 'local candidates complete');
      }
    });
    this.peerConnection.addEventListener('icecandidateerror', (event) => {
      this.logNetworkEvent(
        'ICE candidate error',
        `code=${event.errorCode} address=${event.address || 'unknown'} port=${event.port || 'unknown'} ${String(event.errorText || '').slice(0, 120)}`
      );
    });
    this.peerConnection.addEventListener('negotiationneeded', () => {
      this.logNetworkEvent('PeerConnection', 'negotiationneeded');
    });
    this.peerConnection.addEventListener('signalingstatechange', () => {
      this.logNetworkEvent('PeerConnection signaling state', this.peerConnection?.signalingState || 'unknown');
    });
    this.peerConnection.addEventListener('icegatheringstatechange', () => {
      this.logNetworkEvent('ICE gathering state', this.peerConnection?.iceGatheringState || 'unknown');
    });
    this.peerConnection.addEventListener('track', (event) => {
      this.logNetworkEvent('Remote track', `kind=${event.track.kind} readyState=${event.track.readyState}`);
      const audio = $('remoteAudio');
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      const participantName = this.localRole === 'host'
        ? (this.pendingGuest?.name || 'Guest')
        : 'Host';
      void this.startRemoteWaveform(event.track, participantName).catch((error) => {
        this.setStatus(`Unable to display the other participant’s waveform: ${error.message}`, true);
      });
      event.track.addEventListener('unmute', () => {
        this.logNetworkEvent('Remote track', `kind=${event.track.kind} unmute`);
        void this.playRemoteAudio();
      });
      event.track.addEventListener('mute', () => {
        this.logNetworkEvent('Remote track', `kind=${event.track.kind} mute`);
        $('playRemoteAudioButton').hidden = true;
        this.setRemoteWaveState('Audio stopped', false, event.track.id);
        this.setCallState('The other participant’s audio is temporarily paused. Check their microphone status.');
      });
      event.track.addEventListener('ended', () => {
        this.logNetworkEvent('Remote track', `kind=${event.track.kind} ended`);
        $('playRemoteAudioButton').hidden = true;
        this.stopRemoteWaveform(event.track.id);
        this.setCallState('The other participant’s audio track has ended.');
      });
      if (event.track.muted) {
        this.setCallState('Waiting for the call connection. Audio from the other participant’s microphone has not arrived yet.');
      } else {
        void this.playRemoteAudio();
      }
    });
    this.peerConnection.addEventListener('connectionstatechange', () => {
      const state = this.peerConnection?.connectionState;
      this.logNetworkEvent('PeerConnection state', `connection=${state || 'unknown'} ice=${this.peerConnection?.iceConnectionState || 'unknown'}`);
      this.updateReadinessUI();
      if (state === 'connected') {
        window.clearTimeout(this.disconnectTimer);
        this.retryCount = 0;
        if (this.connected && this.authFields) this.recordingTransfer.refreshInventory();
        this.startConnectionStats();
        if ($('playRemoteAudioButton').hidden) {
          const track = $('remoteAudio').srcObject?.getAudioTracks().find((item) => item.readyState === 'live');
          this.setCallState(track && !track.muted
            ? 'On call · Opus · Receiving audio from the other participant'
            : 'Call connected · Waiting for audio from the other participant’s microphone');
        }
      } else if (state === 'failed') {
        this.stopConnectionStats();
        this.setCallState('Connection failed. Reconnect or continue recording locally.');
        this.scheduleIceRestart(0);
      } else if (state === 'disconnected') {
        this.stopConnectionStats();
        this.setCallState('Connection is unstable. Trying to reconnect…');
        this.scheduleIceRestart();
      } else if (state === 'connecting' || state === 'new') {
        this.stopConnectionStats();
      }
    });
    this.peerConnection.addEventListener('iceconnectionstatechange', () => {
      this.logNetworkEvent('ICE connection state', this.peerConnection?.iceConnectionState || 'unknown');
      if (this.peerConnection?.iceConnectionState === 'disconnected') this.scheduleIceRestart();
    });
  }

  startConnectionStats() {
    window.clearInterval(this.statsTimer);
    this.previousStats = null;
    this.previousTransferStats = null;
    this.transferSendMbps = null;
    $('connectionStats').hidden = false;
    $('connectionStats').textContent = '—';
    void this.updateConnectionStats();
    this.statsTimer = window.setInterval(() => { void this.updateConnectionStats(); }, 2000);
  }

  stopConnectionStats() {
    window.clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.previousStats = null;
    this.previousTransferStats = null;
    this.transferSendMbps = null;
    const stats = $('connectionStats');
    stats.hidden = false;
    stats.textContent = '—';
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
        parts.push(`Loss ${intervalStats.packetLossPercent.toFixed(1)}%`);
      }
      if (intervalStats.bitrateKbps !== null) {
        parts.push(`Send ${Math.round(intervalStats.bitrateKbps)} kbps`);
      }
      const stats = $('connectionStats');
      stats.hidden = false;
      stats.textContent = parts.length ? parts.join(' · ') : '—';
    } catch (error) {
      if (this.peerConnection !== peerConnection) return;
      $('connectionStats').hidden = false;
      $('connectionStats').textContent = `Unable to get connection statistics: ${error.message}`;
      this.logNetworkEvent('WebRTC stats error', error.message);
    } finally {
      this.statsRefreshInProgress = false;
    }
  }

  prepareOpus(transceiver) {
    const codecs = RTCRtpSender.getCapabilities?.('audio')?.codecs || [];
    const opus = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
    if (!opus.length || !transceiver.setCodecPreferences) {
      throw new Error('Unable to verify Opus selection. A call cannot be started in this environment.');
    }
    transceiver.setCodecPreferences(opus);
  }

  async receiveOffer(message) {
    if (!this.invitation || !this.guestIdentity || !message.auth || typeof message.sdp !== 'string') {
      throw new Error('Rejected a call invitation that does not contain authentication information.');
    }
    const auth = message.auth;
    if (auth.roomId !== this.invitation.roomId || auth.guestNonce === undefined ||
        auth.guestPublicKey !== toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', this.guestIdentity.publicKey)))) {
      throw new Error('This call invitation is for a different room or participant.');
    }
    const hostKey = await importPublicKey(this.invitation.hostPublicKey);
    await this.createPeerConnection();
    await this.peerConnection.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    await this.flushCandidates();
    const actualHostFingerprint = fingerprintFromSdp(this.peerConnection.remoteDescription.sdp);
    if (auth.guestNonce !== this.guestNonce || auth.hostFingerprint !== actualHostFingerprint ||
        !(await verify(hostKey, auth.signature, transcript(auth)))) {
      throw new Error('The host signature or DTLS fingerprint does not match.');
    }
    const transceiver = this.peerConnection.getTransceivers().find((item) => item.receiver.track.kind === 'audio');
    if (!transceiver) throw new Error('No audio call transceiver is available.');
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
    this.setStatus('Response sent. Microphone audio will not be sent until DTLS authentication is complete.');
  }

  async receiveAnswer(message) {
    if (!this.peerConnection || !this.pendingGuest || !message.auth || typeof message.sdp !== 'string') {
      throw new Error('The call response is not authenticated.');
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
      throw new Error('The participant signature or DTLS fingerprint does not match.');
    }
    this.authFields = expectedFields;
    this.remoteTransferProgress = null;
    const signature = await sign(this.hostKeys.privateKey, transcript(this.authFields));
    this.send({ type: 'auth-confirm', auth: { ...this.authFields, signature } });
    await this.attachLocalAudio();
    this.connected = true;
    this.recordingTransfer.wake();
    this.setStatus('Participant signature and DTLS fingerprint verified.');
    this.setCallState('Connecting call…');
    await this.checkLocalReadiness();
    if (this.getRecordingState()) {
      await this.onRecordingState?.(false);
      this.setStatus('Recording that started before the connection was stopped. Start a new take after both participants are ready.', true);
    }
    await this.flushCandidates();
  }

  async receiveAuthConfirm(message) {
    if (!this.peerConnection || !this.guestIdentity || !this.authFields || !message.auth) {
      throw new Error('Host authentication is missing.');
    }
    const auth = message.auth;
    const actualHostFingerprint = fingerprintFromSdp(this.peerConnection.remoteDescription.sdp);
    if (auth.roomId !== this.authFields.roomId || auth.generation !== this.authFields.generation ||
        auth.hostNonce !== this.authFields.hostNonce || auth.guestNonce !== this.guestNonce ||
        auth.hostFingerprint !== actualHostFingerprint ||
        auth.guestFingerprint !== fingerprintFromSdp(this.peerConnection.localDescription.sdp) ||
        auth.guestPublicKey !== this.authFields.guestPublicKey ||
        !(await verify(await importPublicKey(this.invitation.hostPublicKey), auth.signature, transcript(this.authFields)))) {
      throw new Error('Host signature verification or DTLS fingerprint does not match.');
    }
    await this.attachLocalAudio();
    this.connected = true;
    this.recordingTransfer.wake();
    this.setStatus('Host and both signatures and DTLS fingerprints verified.');
    this.setCallState('Connecting call…');
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
    if (!message.ready) this.setStatus('The other participant is not ready to record. Check their status.', true);
    else if (this.localReady) this.setStatus('Both devices are ready to record.');
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
      this.setCallState('Reconnection was interrupted. End the call or continue recording locally.');
      return;
    }
    this.retryCount += 1;
    try {
      this.peerConnection.restartIce();
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      this.send({ type: 'ice-restart', sdp: this.peerConnection.localDescription.sdp });
      this.setCallState(`Reconnecting (${this.retryCount}/${MAX_SIGNAL_RETRIES})`);
    } catch (error) {
      this.setCallState(`Unable to reconnect: ${error.message}`);
    }
  }

  async attachLocalAudio(replacementStream = null) {
    if (replacementStream && (!this.connected || !this.authFields)) {
      throw new Error('There is no authenticated call.');
    }
    if (!this.localSender) throw new Error('No outgoing audio track is available.');
    const stream = replacementStream ?? await this.getMicrophoneStream();
    await this.localSender.replaceTrack(stream.getAudioTracks()[0]);
    const parameters = this.localSender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 32000;
    try {
      await this.localSender.setParameters(parameters);
    } catch {
      this.setStatus('The call is authenticated, but the 32 kbps limit could not be set. Connecting with the browser default.');
    }
    this.onLocalStream?.(stream);
  }

  async playRemoteAudio() {
    for (const waveform of this.remoteWaveforms.values()) {
      if (waveform.audioContext?.state === 'suspended') {
        void waveform.audioContext.resume().catch((error) => {
          this.setRemoteWaveState('Waveform stopped', false, waveform.id);
          this.setCallState(`The other participant’s audio is connected, but the waveform could not start: ${error.message}`);
        });
      }
    }
    const audio = $('remoteAudio');
    const track = audio.srcObject?.getAudioTracks().find((item) => item.readyState === 'live' && !item.muted);
    if (!track) {
      $('playRemoteAudioButton').hidden = true;
      this.setCallState('Audio from the other participant has not arrived yet. Check their microphone and call status.');
      return;
    }
    try {
      await audio.play();
      $('playRemoteAudioButton').hidden = true;
      this.setCallState('On call · Playing audio from the other participant');
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        $('playRemoteAudioButton').hidden = false;
        this.setCallState('Audio from the other participant is available, but autoplay is restricted. Select “Allow Audio Playback.”');
        return;
      }
      $('playRemoteAudioButton').hidden = true;
      this.setCallState(`Unable to play audio from the other participant: ${error.message}`);
    }
  }

  async copyInvite() {
    try {
      await navigator.clipboard.writeText($('inviteUrl').value);
      this.setStatus('Invitation link copied. Share it only with the intended participant.');
    } catch {
      $('inviteUrl').focus();
      $('inviteUrl').select();
      this.setStatus('Unable to copy automatically. Copy the selected link.', true);
    }
  }

  async leave({ keepMessage = false } = {}) {
    window.clearTimeout(this.disconnectTimer);
    for (const pending of this.pendingRecordingCommands.values()) window.clearTimeout(pending.timer);
    this.pendingRecordingCommands.clear();
    this.clearPendingClockProbes();
    this.clearPendingStartEvents();
    this.releasePreparedRecordingAudioContext?.();
    this.clockOffsetMs = null;
    const previousRole = this.localRole;
    const wasConnected = this.connected;
    this.recordingTransfer.close();
    this.inputMonitorChannel?.close();
    this.inputMonitorChannel = null;
    this.remoteInputMonitorState = { level: 0, muted: null, deviceLabel: '' };
    this.peerConnection?.close();
    this.peerConnection = null;
    this.stopConnectionStats();
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
    this.setRemoteWaveState('Not connected');
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
    this.setCallState('Call is not connected');
    this.updateReadinessUI();
    if (!keepMessage) {
      const message = previousRole === 'guest' && !wasConnected
        ? 'Join request canceled.'
        : previousRole === 'host' && !wasConnected
          ? 'Invitation ended.'
          : 'Call ended. Local recordings remain on this device.';
      this.setStatus(message);
    }
  }

  async requestLeave() {
    if (this.localRole === 'guest' && this.hasPendingTransfer) {
      try {
        if (await this.hasPendingTransfer(this.authFields?.generation) &&
            !window.confirm('Some audio has not been confirmed as saved on the host. If you leave, it will remain only on this device and transfers in progress will stop. Leave anyway?')) {
          return;
        }
      } catch (error) {
        this.setStatus(`Unable to verify save status on the host: ${error.message}`, true);
        if (!window.confirm('The host save status is unknown. Audio may remain only on this device. Leave anyway?')) {
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
