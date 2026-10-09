import { getAuth0Client, getHostDisplayName, getHostSession, signOut } from './auth-client.bundle.js';
import { RoomCall } from './room-call.js';
import { MAX_SESSION_FRAMES, remainingSessionFrames } from './recording-limits.js';
import {
  RecordingTransfer,
  takeWithTransferParticipant
} from './recording-transfer.js';
import { canQueueRecordingCommit } from './recording-commit-queue.js';
import { verifyIncomingStoredChunk, verifyIncomingStoredTake } from './recording-storage.js';
import { reconcileTransferInventory } from './transfer-inventory.js';
import { createPcm24Wav, writePcm24Wav } from './wav-export.js';
import { splitTransferBacklog, summarizeTransferChunks } from './transfer-progress.js';
import { monitorRecordingTrack } from './recording-track-monitor.js';
import { makeRecordingFilename } from './recording-filename.js';
import { createStartPlan, sameStartPlan } from './recording-timing.js';
import { assessAlignment, writeAlignedPcm24Wav, MAX_TIMING_POINTS } from './drift-correction.js';
import { mergeRecordingMetadata, synchronizationForTake } from './recording-ledger.js';
import { connectFirstMicrophoneChannel } from './microphone-input.js';
import { appendAlignedWaveformPeak, resetWaveformHistory } from './waveform-history.js';

const TARGET_RATE = 48000;
const SYNCHRONIZED_START_LEAD_MS = 500;
const BYTES_PER_FRAME = 3;
const CHUNK_FRAMES = TARGET_RATE;
const DB_NAME = 'perfectpodcast-local-v1';
const DB_VERSION = 3;
const BLOB_DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const MAX_WAV_BYTES = 1024 * 1024 * 1024;
const RAW_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 2 },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};

const $ = (id) => document.getElementById(id);
const setupView = $('setupView');
const studioView = $('studioView');
const setupForm = $('setupForm');
const participantNameInput = $('participantName');
const micDevice = $('micDevice');
const trackMicDevice = $('trackMicDevice');
const sessionList = $('sessionList');
const takeList = $('takeList');
const studioTitleInput = $('studioTitle');
const recordButton = $('recordButton');
const stopButton = $('stopButton');
const recordingPreparation = $('recordingPreparation');
const errorText = $('errorText');
const notice = $('notice');
const meter = document.querySelector('[role="meter"]');
const waveformCanvas = $('waveformCanvas');
const networkEventLogStartedAt = performance.now();

let database;
let activeSession = null;
let studioTitleSavePromise = Promise.resolve(true);
let studioTitleSaveFailed = false;
let roomCall = null;
let activeTake = null;
let audioContext = null;
let primedRecordingAudioContext = null;
let primedRecordingAudioContextResume = null;
let primedRecordingAudioContextAnchor = null;
let mediaStream = null;
let sourceNode = null;
let inputChannelNode = null;
let analyserNode = null;
let recorderNode = null;
let silentGain = null;
let previewAudioContext = null;
let previewSourceNode = null;
let previewInputChannelNode = null;
let previewAnalyserNode = null;
let previewSilentGain = null;
let previewSamples = null;
let previewStream = null;
let microphoneMuted = false;
let recording = false;
let captureOnAir = false;
let captureStartPending = false;
let finalizing = false;
let starting = false;
let cancelRecordingStart = false;
let sessionLimitReached = false;
let pendingCommits = 0;
let commitChain = Promise.resolve();
let commitError = null;
let nextSequence = 0;
let capturedFrames = 0;
let takeFrameLimit = 0;
let elapsedTimer = null;
let scheduledRecordingStartAt = null;
let scheduledRecordingWallStartAt = null;
let takeRefreshTimer = null;
let noticeTimer = null;
let takeStartedAt = 0;
let preparedRecordingEvent = null;
let lastPeak = 0;
let waveformSamples = null;
let waveformFrame = null;
let meterFrame = null;
const localWaveform = {
  history: new Float32Array(600),
  historyCount: 0,
  lastSampleIndex: -1,
  recordingStartedAt: null,
  sampledAt: 0,
  startedAt: 0,
  rulerSecond: -1
};
let waveformElapsedSeconds = 0;
let hostRecordingCommand = Promise.resolve();
let lastHostRecordingState = null;
const receivedTransferFrames = new Map();
let transferProgressTimer = null;
let transferProgressCache = null;
let transferGraphSamples = [];
let cleanupRecordingTrackMonitor = null;
let checkRecordingTrackMute = null;
let switchingMicrophone = false;
let detectingDevices = false;
let deletingSession = false;
let participantNameEdited = false;
let networkEventCount = 0;
const selectedSessionIds = new Set();

const requestResult = (request) => new Promise((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed')), { once: true });
});

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('IndexedDB transaction aborted')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error || new Error('IndexedDB transaction failed')), { once: true });
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser. Use Chrome or Edge.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('takes')) {
        const takes = db.createObjectStore('takes', { keyPath: 'id' });
        takes.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const chunks = db.createObjectStore('chunks', { keyPath: ['takeId', 'sequence'] });
        chunks.createIndex('takeId', 'takeId', { unique: false });
      }
      const takes = request.transaction.objectStore('takes');
      if (!takes.indexNames.contains('transferGeneration')) {
        takes.createIndex('transferGeneration', 'transferGeneration', { unique: false });
      }
      const chunks = request.transaction.objectStore('chunks');
      if (chunks.indexNames.contains('transferState')) chunks.deleteIndex('transferState');
      if (!chunks.indexNames.contains('transferGeneration')) {
        chunks.createIndex('transferGeneration', 'transferGeneration', { unique: false });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('Unable to open the local recording database.')), { once: true });
    request.addEventListener('blocked', () => reject(new Error('Another tab is blocking the database update. Close the recording tab and reload the page.')), { once: true });
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function appendNetworkEvent(event, details = '') {
  const log = $('networkEventLog');
  if (!log) return;
  const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const elapsed = (performance.now() - networkEventLogStartedAt).toFixed(1).padStart(9, ' ');
  const detailText = details ? ` ${details}` : '';
  log.setRangeText(
    `${new Date().toISOString()} +${elapsed} ms | ${event}${detailText}\n`,
    log.value.length,
    log.value.length,
    'preserve'
  );
  networkEventCount += 1;
  $('networkEventCount').textContent = `${networkEventCount} EVENTS`;
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

function updateCaptureStatusBadge() {
  const badge = $('captureStatusBadge');
  const isOnAir = captureOnAir;
  const isPending = !isOnAir && (captureStartPending || starting);
  badge.classList.toggle('on', isOnAir);
  badge.classList.toggle('pending', isPending);
  badge.classList.toggle('off', !isOnAir && !isPending);
  badge.setAttribute('aria-label', isOnAir ? 'On air' : isPending ? 'Waiting to go on air' : 'Not on air');
}

function setStatus(_text, _kind = 'ready') {
  updateCaptureStatusBadge();
}

function updateRecordingPreparation() {
  recordingPreparation.hidden = true;
}

function updateRecordButtonAvailability() {
  trackMicDevice.disabled = recording || starting || finalizing || switchingMicrophone || detectingDevices ||
    Boolean(roomCall?.readinessCheckInProgress) || !trackMicDevice.value;
  const deleteSessionButton = $('deleteSessionButton');
  if (deleteSessionButton) {
    deleteSessionButton.hidden = !activeSession || roomCall?.isGuest === true;
    deleteSessionButton.disabled = recording || starting || finalizing || switchingMicrophone ||
      deletingSession || Boolean(roomCall?.isActive);
  }
  recordButton.disabled = sessionLimitReached || recording || starting || finalizing || switchingMicrophone ||
    Boolean(roomCall?.isActive && !roomCall.isGuest && !roomCall.canStartRecording);
}

function guestTakesAreStored(takes) {
  return takes.every((take) =>
    !take.remote && Boolean(take.transferGeneration) &&
    take.status !== 'recording' && take.hostStored === true
  );
}

function clearRecordingTrackMonitor() {
  const cleanup = cleanupRecordingTrackMonitor;
  cleanupRecordingTrackMonitor = null;
  cleanup?.();
}

function setMessage(message, isError = false) {
  notice.textContent = message;
  notice.className = `notice show${isError ? ' error' : ''}`;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.className = 'notice'; }, 4200);
}

function updateTimer() {
  if (!recording) return;
  const elapsed = performance.now() - takeStartedAt;
  $('timer').textContent = formatDuration(elapsed / 1000);
  if (elapsed >= takeFrameLimit / TARGET_RATE * 1000) {
    void stopRecording().then((saved) => setMessage(
      saved
        ? 'Recording stopped and saved because this session reached its 2-hour limit.'
        : 'Recording stopped because this session reached its 2-hour limit. Check the save status.',
      !saved
    ));
  }
}

function updateMeter(peak) {
  lastPeak = Math.max(lastPeak * 0.82, peak);
  const db = lastPeak > 0.0001 ? 20 * Math.log10(lastPeak) : -Infinity;
  const percent = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
  const fill = $('meterFill');
  fill.style.height = `${percent}%`;
  fill.className = `meter-fill${lastPeak >= 0.999 ? ' clipping' : db >= -6 ? ' near-clip' : db >= -40 ? ' good' : ''}`;
  meter.setAttribute('aria-valuenow', String(Math.round(percent)));
  roomCall?.sendInputMonitorState(peak, microphoneMuted, getLocalMicrophoneLabel());
}

function getLocalMicrophoneLabel() {
  return (trackMicDevice.selectedOptions[0]?.textContent || micDevice.selectedOptions[0]?.textContent || '')
    .trim()
    .slice(0, 120);
}

function getLiveMicrophoneTracks() {
  return [...new Set([mediaStream, previewStream]
    .filter(Boolean)
    .flatMap((stream) => stream.getAudioTracks()))]
    .filter((track) => track.readyState === 'live');
}

function updateMicrophoneMuteButton() {
  const button = $('microphoneMuteButton');
  button.disabled = getLiveMicrophoneTracks().length === 0;
  button.textContent = microphoneMuted ? 'UNMUTE' : 'MUTE';
  button.setAttribute('aria-pressed', String(microphoneMuted));
  button.setAttribute('aria-label', microphoneMuted ? 'Unmute microphone' : 'Mute microphone');
}

function toggleMicrophoneMute() {
  const tracks = getLiveMicrophoneTracks();
  if (!tracks.length) {
    setMessage('No microphone is connected to mute.', true);
    updateMicrophoneMuteButton();
    return;
  }
  microphoneMuted = !microphoneMuted;
  for (const track of tracks) track.enabled = !microphoneMuted;
  if (microphoneMuted) lastPeak = 0;
  updateMicrophoneMuteButton();
  updateMeter(microphoneMuted ? 0 : lastPeak);
}

function samplePreviewMeter() {
  meterFrame = null;
  if (!previewStream || !previewAnalyserNode || !previewSamples || recording) return;
  if (previewAudioContext?.state === 'running') {
    previewAnalyserNode.getFloatTimeDomainData(previewSamples);
    let peak = 0;
    for (const sample of previewSamples) peak = Math.max(peak, Math.abs(sample));
    updateMeter(peak);
  }
  meterFrame = window.requestAnimationFrame(samplePreviewMeter);
}

function startMeterMonitoring() {
  if (meterFrame === null) meterFrame = window.requestAnimationFrame(samplePreviewMeter);
}

function stopMeterMonitoring() {
  if (meterFrame !== null) window.cancelAnimationFrame(meterFrame);
  meterFrame = null;
}

function setLocalWaveformState(text, live = false) {
  $('waveformState').textContent = /^Waiting\b/i.test(text) ? '' : text;
  $('waveformState').classList.toggle('live', live);
}

function startLocalPreview(stream) {
  if (!stream || recording || starting || previewStream === stream) return;
  stopLocalPreview();
  previewStream = stream;
  for (const track of stream.getAudioTracks()) track.enabled = !microphoneMuted;
  updateMicrophoneMuteButton();
  if (!window.AudioContext) {
    setLocalWaveformState('Waveform unavailable');
    return;
  }
  try {
    previewAudioContext = new AudioContext();
    previewSourceNode = previewAudioContext.createMediaStreamSource(stream);
    previewAnalyserNode = previewAudioContext.createAnalyser();
    previewAnalyserNode.fftSize = 2048;
    previewSamples = new Float32Array(previewAnalyserNode.fftSize);
    previewSilentGain = previewAudioContext.createGain();
    previewSilentGain.gain.value = 0;
    previewInputChannelNode = connectFirstMicrophoneChannel(previewAudioContext, previewSourceNode, previewAnalyserNode);
    previewAnalyserNode.connect(previewSilentGain).connect(previewAudioContext.destination);
    lastPeak = 0;
    updateMeter(0);
    const context = previewAudioContext;
    if (context.state === 'running') {
      setLocalWaveformState('Waiting to record');
      startMeterMonitoring();
    } else if (context.state === 'suspended') {
      setLocalWaveformState('Preparing waveform');
      void context.resume().then(() => {
        if (previewAudioContext === context && !recording) {
          setLocalWaveformState('Waiting to record');
          startMeterMonitoring();
        }
      }).catch((error) => {
        if (previewAudioContext !== context) return;
        setLocalWaveformState('Waveform stopped');
        setMessage(`Unable to start your waveform: ${error.message}`, true);
      });
    } else {
      setLocalWaveformState('Waveform stopped');
    }
  } catch (error) {
    stopLocalPreview();
    setLocalWaveformState('Waveform error');
    setMessage(`Unable to start your waveform: ${error.message}`, true);
  }
}

function stopLocalPreview({ preserveAudioContext = false } = {}) {
  stopMeterMonitoring();
  previewSourceNode?.disconnect();
  previewInputChannelNode?.disconnect();
  previewAnalyserNode?.disconnect();
  if (!preserveAudioContext) previewSilentGain?.disconnect();
  if (!preserveAudioContext && previewAudioContext && previewAudioContext.state !== 'closed') {
    void previewAudioContext.close();
  }
  previewAudioContext = null;
  previewSourceNode = null;
  previewInputChannelNode = null;
  previewAnalyserNode = null;
  previewSilentGain = null;
  previewSamples = null;
  previewStream = null;
  updateMicrophoneMuteButton();
}

function stopWaveformRendering() {
  if (waveformFrame !== null) window.cancelAnimationFrame(waveformFrame);
  waveformFrame = null;
  resetWaveformHistory(localWaveform, null);
  waveformElapsedSeconds = 0;
  const context = waveformCanvas.getContext('2d');
  if (context) context.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

function drawWaveform() {
  waveformFrame = null;
  if (!recording) return;
  const context = waveformCanvas.getContext('2d');
  if (!context || !waveformCanvas.parentElement) return;
  const bounds = waveformCanvas.parentElement.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (waveformCanvas.width !== width || waveformCanvas.height !== height) {
    waveformCanvas.width = width;
    waveformCanvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  context.beginPath();
  context.lineWidth = 1;
  context.strokeStyle = '#3b464e';
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  const now = performance.now();
  waveformElapsedSeconds = (now - takeStartedAt) / 1000;
  const elapsedSeconds = waveformElapsedSeconds;
  if (analyserNode && waveformSamples && audioContext?.state === 'running' &&
      now - localWaveform.sampledAt >= 100) {
    analyserNode.getFloatTimeDomainData(waveformSamples);
    let peak = 0;
    for (const sample of waveformSamples) peak = Math.max(peak, Math.abs(sample));
    appendAlignedWaveformPeak(localWaveform, peak, now);
    localWaveform.sampledAt = now;
    setLocalWaveformState('LIVE', true);
  }
  if (localWaveform.historyCount > 0) {
    context.beginPath();
    context.lineWidth = Math.max(1, pixelRatio);
    context.strokeStyle = '#55d6b2';
    context.shadowColor = 'rgb(85 214 178 / 45%)';
    context.shadowBlur = 5 * pixelRatio;
    for (let index = 0; index < localWaveform.historyCount; index += 1) {
      const x = (index / localWaveform.history.length) * width;
      const amplitude = Math.sqrt(Math.max(0, localWaveform.history[index])) * height * 0.44;
      context.moveTo(x, height / 2 - amplitude);
      context.lineTo(x, height / 2 + amplitude);
    }
    context.stroke();
    context.shadowBlur = 0;
  }
  const rulerSecond = Math.floor(elapsedSeconds);
  if (rulerSecond !== localWaveform.rulerSecond) {
    const firstMark = elapsedSeconds >= 60 ? elapsedSeconds - 60 : 0;
    for (let index = 0; index < 5; index += 1) {
      $('waveMark' + index).textContent = formatDuration(firstMark + index * 15);
    }
    localWaveform.rulerSecond = rulerSecond;
  }
  if (recording) waveformFrame = window.requestAnimationFrame(drawWaveform);
}

async function runRequest(storeName, method, ...args) {
  const transaction = database.transaction(storeName, 'readonly');
  const done = transactionComplete(transaction);
  const result = await requestResult(transaction.objectStore(storeName)[method](...args));
  await done;
  return result;
}

async function loadAll(storeName) {
  return runRequest(storeName, 'getAll');
}

async function persistSession(session) {
  const transaction = database.transaction('sessions', 'readwrite');
  const done = transactionComplete(transaction);
  transaction.objectStore('sessions').put(session);
  await done;
}

function saveStudioSessionName() {
  const session = activeSession;
  if (!session || roomCall?.isGuest === true) return Promise.resolve(true);
  const name = studioTitleInput.value.trim();
  if (!name) return studioTitleSavePromise;
  if (name === session.name && !studioTitleSaveFailed) return studioTitleSavePromise;

  session.name = name;
  const sessionToSave = { ...session };
  studioTitleSaveFailed = false;
  studioTitleSavePromise = studioTitleSavePromise
    .then(() => persistSession(sessionToSave))
    .then(() => {
      studioTitleSaveFailed = false;
      if (errorText.textContent.startsWith('Unable to save session name:')) errorText.textContent = '';
      roomCall?.setSessionName(sessionToSave.name);
      return true;
    })
    .catch((error) => {
      studioTitleSaveFailed = true;
      errorText.textContent = `Unable to save session name: ${error.message}`;
      return false;
    });
  return studioTitleSavePromise;
}

async function deleteSessionsAndRecordings(sessionIds) {
  const uniqueSessionIds = [...new Set(sessionIds)];
  const transaction = database.transaction(['sessions', 'takes', 'chunks'], 'readwrite');
  const done = transactionComplete(transaction);
  const takes = transaction.objectStore('takes');
  const chunks = transaction.objectStore('chunks').index('takeId');
  const sessionStore = transaction.objectStore('sessions');
  for (const sessionId of uniqueSessionIds) {
    sessionStore.delete(sessionId);
    const takeRequest = takes.index('sessionId').openCursor(IDBKeyRange.only(sessionId));
    takeRequest.addEventListener('error', () => transaction.abort(), { once: true });
    takeRequest.addEventListener('success', () => {
      const takeCursor = takeRequest.result;
      if (!takeCursor) return;
      const takeId = takeCursor.primaryKey;
      takes.delete(takeId);
      const chunkRequest = chunks.openCursor(IDBKeyRange.only(takeId));
      chunkRequest.addEventListener('error', () => transaction.abort(), { once: true });
      chunkRequest.addEventListener('success', () => {
        const chunkCursor = chunkRequest.result;
        if (!chunkCursor) return;
        chunkCursor.delete();
        chunkCursor.continue();
      });
      takeCursor.continue();
    });
  }
  await done;
}

async function deleteSessionAndRecordings(sessionId) {
  await deleteSessionsAndRecordings([sessionId]);
}

async function persistTake(take) {
  const transaction = database.transaction('takes', 'readwrite');
  const done = transactionComplete(transaction);
  transaction.objectStore('takes').put(take);
  await done;
}

async function deleteUnstartedTake(takeId) {
  const transaction = database.transaction('takes', 'readwrite');
  const done = transactionComplete(transaction);
  transaction.objectStore('takes').delete(takeId);
  await done;
}

async function findIndexValue(storeName, indexName, range, predicate = () => true) {
  const transaction = database.transaction(storeName, 'readonly');
  const done = transactionComplete(transaction);
  try {
    const value = await new Promise((resolve, reject) => {
      const request = transaction.objectStore(storeName).index(indexName).openCursor(range);
      request.addEventListener('error', () => reject(request.error || new Error('IndexedDB cursor failed')), { once: true });
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(null);
        } else if (predicate(cursor.value)) {
          resolve(cursor.value);
        } else {
          cursor.continue();
        }
      });
    });
    await done;
    return value;
  } catch (error) {
    await done.catch(() => {});
    throw error;
  }
}

async function findIndexValues(storeName, indexName, range, predicate = () => true, project = (value) => value) {
  const transaction = database.transaction(storeName, 'readonly');
  const done = transactionComplete(transaction);
  try {
    const values = await new Promise((resolve, reject) => {
      const result = [];
      const request = transaction.objectStore(storeName).index(indexName).openCursor(range);
      request.addEventListener('error', () => reject(request.error || new Error('IndexedDB cursor failed')), { once: true });
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        if (predicate(cursor.value)) result.push(project(cursor.value));
        cursor.continue();
      });
    });
    await done;
    return values;
  } catch (error) {
    await done.catch(() => {});
    throw error;
  }
}

async function getNextTransferChunk(generation) {
  const chunk = await findIndexValue(
    'chunks',
    'transferGeneration',
    IDBKeyRange.only(generation),
    (item) => !item.remote && item.hostStored !== true
  );
  if (!chunk) return null;
  const storedTake = await runRequest('takes', 'get', chunk.takeId);
  if (!storedTake) return null;
  const take = await ensureTransferParticipant(storedTake);
  return { take, chunk };
}

async function ensureTransferParticipant(take) {
  const updatedTake = takeWithTransferParticipant(take, activeSession?.participant);
  if (take.participant === updatedTake.participant) return take;
  await persistTake(updatedTake);
  return updatedTake;
}

async function prepareTransferChunk(takeId, sequence, sha256) {
  const transaction = database.transaction('chunks', 'readwrite');
  const done = transactionComplete(transaction);
  const store = transaction.objectStore('chunks');
  const request = store.get([takeId, sequence]);
  request.addEventListener('success', () => {
    const chunk = request.result;
    if (!chunk || (chunk.sha256 && chunk.sha256 !== sha256)) {
      transaction.abort();
      return;
    }
    store.put({ ...chunk, sha256, hostStored: chunk.hostStored === true });
  }, { once: true });
  await done;
}

async function markTransferChunkStored(takeId, sequence, sha256) {
  const transaction = database.transaction(['chunks', 'takes'], 'readwrite');
  const done = transactionComplete(transaction);
  const chunks = transaction.objectStore('chunks');
  const takes = transaction.objectStore('takes');
  const chunkRequest = chunks.get([takeId, sequence]);
  const takeRequest = takes.get(takeId);
  let chunkLoaded = false;
  let takeLoaded = false;
  let chunk;
  let take;
  let newlyStoredChunk = null;
  const persistConfirmation = () => {
    if (!chunkLoaded || !takeLoaded) return;
    if (!take) {
      transaction.abort();
      return;
    }
    const confirmedChunks = Array.isArray(take.hostStoredChunks) ? [...take.hostStoredChunks] : [];
    const existingConfirmation = confirmedChunks.find((item) => item.sequence === sequence);
    if (existingConfirmation) {
      if (existingConfirmation.sha256 !== sha256) transaction.abort();
      return;
    }
    if (!chunk || (chunk.sha256 && chunk.sha256 !== sha256)) {
      transaction.abort();
      return;
    }
    newlyStoredChunk = chunk;
    confirmedChunks.push({
      sequence,
      sha256,
      bytes: chunk.byteLength ?? chunk.wav?.size ?? 0,
      frames: chunk.frames
    });
    confirmedChunks.sort((left, right) => left.sequence - right.sequence);
    takes.put({ ...take, hostStoredChunks: confirmedChunks });
    chunks.delete([takeId, sequence]);
  };
  chunkRequest.addEventListener('success', () => {
    chunk = chunkRequest.result;
    chunkLoaded = true;
    persistConfirmation();
  }, { once: true });
  takeRequest.addEventListener('success', () => {
    take = takeRequest.result;
    takeLoaded = true;
    persistConfirmation();
  }, { once: true });
  await done;
  if (newlyStoredChunk?.transferGeneration) {
    const chunkBytes = newlyStoredChunk.byteLength ?? newlyStoredChunk.wav?.size ?? 0;
    updateTransferProgressCache(newlyStoredChunk.transferGeneration, 'guest', (progress) => ({
      hostStoredBytes: progress.hostStoredBytes + chunkBytes,
      hostStoredFrames: progress.hostStoredFrames + newlyStoredChunk.frames,
      pendingBytes: Math.max(0, progress.pendingBytes - chunkBytes),
      pendingFrames: Math.max(0, progress.pendingFrames - newlyStoredChunk.frames)
    }));
  }
}

async function loadTakeChunks(takeId) {
  return findIndexValues(
    'chunks',
    'takeId',
    IDBKeyRange.only(takeId),
    () => true,
    (chunk) => ({
      takeId: chunk.takeId,
      sourceTakeId: chunk.sourceTakeId,
      transferGeneration: chunk.transferGeneration,
      sequence: chunk.sequence,
      startFrame: chunk.startFrame,
      frames: chunk.frames,
      byteLength: chunk.byteLength,
      wav: chunk.wav,
      sha256: chunk.sha256,
      remote: chunk.remote,
      hostStored: chunk.hostStored
    })
  );
}

async function getTransferInventory(generation) {
  if (!generation) throw new Error('The transfer inventory has no connection generation.');
  transferProgressCache = null;
  const range = IDBKeyRange.only(generation);
  if (roomCall?.localRole === 'guest') {
    const chunkItems = await findIndexValues('chunks', 'transferGeneration', range, (chunk) =>
      chunk.transferGeneration === generation && !chunk.remote && Boolean(chunk.sha256),
    (chunk) => ({ kind: 'chunk', takeId: chunk.takeId, sequence: chunk.sequence, sha256: chunk.sha256 }));
    const takes = await findIndexValues('takes', 'transferGeneration', range, (take) =>
      take.transferGeneration === generation && !take.remote);
    const chunkItemsByKey = new Map(chunkItems.map((item) =>
      [`${item.takeId}:${item.sequence}`, item]));
    for (const take of takes) {
      for (const item of take.hostStoredChunks || []) {
        if (!Number.isSafeInteger(item.sequence) || item.sequence < 0 ||
            !/^[0-9a-f]{64}$/u.test(item.sha256 || '')) {
          throw new Error(`The sent chunk ledger for take ${take.id} is invalid.`);
        }
        const key = `${take.id}:${item.sequence}`;
        const existing = chunkItemsByKey.get(key);
        if (existing && existing.sha256 !== item.sha256) {
          throw new Error(`The saved hash does not match for chunk ${item.sequence + 1} of take ${take.id}.`);
        }
        chunkItemsByKey.set(key, {
          kind: 'chunk',
          takeId: take.id,
          sequence: item.sequence,
          sha256: item.sha256
        });
      }
    }
    const manifests = takes
      .filter((take) => take.status !== 'recording' && take.frames > 0 && take.chunks > 0)
      .map((take) => ({ kind: 'manifest', takeId: take.id }));
    return [...chunkItemsByKey.values(), ...manifests];
  }
  if (roomCall?.localRole !== 'host') throw new Error('This device is not the host for the transfer inventory.');
  const takes = await findIndexValues('takes', 'transferGeneration', IDBKeyRange.only(generation), (take) =>
    take.remote && take.transferGeneration === generation);
  if (!takes.length) return [];
  const takesById = new Map(takes.map((take) => [take.id, take]));
  const chunkRows = await findIndexValues(
    'chunks',
    'transferGeneration',
    IDBKeyRange.only(generation),
    (chunk) => chunk.remote && takesById.has(chunk.takeId),
    (chunk) => ({
      takeId: chunk.takeId,
      sourceTakeId: chunk.sourceTakeId,
      sequence: chunk.sequence,
      startFrame: chunk.startFrame,
      frames: chunk.frames,
      sha256: chunk.sha256
    })
  );
  const grouped = new Map();
  for (const chunk of chunkRows) {
    const chunks = grouped.get(chunk.takeId) || [];
    chunks.push(chunk);
    grouped.set(chunk.takeId, chunks);
  }
  const inventory = [];
  for (const take of takes) {
    const chunks = (grouped.get(take.id) || []).sort((left, right) => left.sequence - right.sequence);
    const savedChunks = await loadTakeChunks(take.id);
    const savedChunksBySequence = new Map(savedChunks.map((chunk) => [chunk.sequence, chunk]));
    if (take.hostStored) {
      try {
        await verifyIncomingStoredTake(take, savedChunks);
      } catch (error) {
        roomCall.setStatus(`Unable to verify received audio in IndexedDB. Recovering the affected take: ${error.message}`, true);
        continue;
      }
    } else {
      for (const chunk of chunks) {
        if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 ||
            !Number.isSafeInteger(chunk.startFrame) || chunk.startFrame < 0 ||
            !Number.isSafeInteger(chunk.frames) || chunk.frames < 1 ||
            !/^[0-9a-f]{64}$/u.test(chunk.sha256 || '') || chunk.sourceTakeId !== take.sourceTakeId) {
          roomCall.setStatus('The host partial-take ledger contains an invalid entry. Recovering the affected chunk.', true);
          continue;
        }
        try {
          const storedChunk = savedChunksBySequence.get(chunk.sequence);
          await verifyIncomingStoredChunk(take, storedChunk, chunk.sequence, chunk.startFrame);
          if (storedChunk.sha256 !== chunk.sha256 || storedChunk.frames !== chunk.frames) {
            throw new Error('The chunk ledger does not match the WAV contents.');
          }
        } catch (error) {
          roomCall.setStatus(`Unable to re-verify the chunk in IndexedDB. Recovering it: ${error.message}`, true);
          continue;
        }
        inventory.push({
          kind: 'chunk',
          takeId: take.sourceTakeId,
          sequence: chunk.sequence,
          sha256: chunk.sha256
        });
      }
      continue;
    }
    inventory.push(...chunks.map((chunk) => ({
      kind: 'chunk',
      takeId: take.sourceTakeId,
      sequence: chunk.sequence,
      sha256: chunk.sha256
    })));
    inventory.push({ kind: 'manifest', takeId: take.sourceTakeId });
  }
  return inventory;
}

async function reconcileGuestTransferInventory(generation, hostItems) {
  const localItems = await getTransferInventory(generation);
  const reconciled = reconcileTransferInventory(localItems, hostItems);
  const hostChunkKeys = new Set(hostItems
    .filter((item) => item.kind === 'chunk')
    .map((item) => `${item.takeId}:${item.sequence}`));
  const confirmedChunks = await findIndexValues(
    'takes',
    'transferGeneration',
    IDBKeyRange.only(generation),
    (take) => !take.remote && Array.isArray(take.hostStoredChunks) && take.hostStoredChunks.length > 0,
    (take) => take.hostStoredChunks.map((item) => ({ takeId: take.id, ...item }))
  );
  for (const chunks of confirmedChunks) {
    for (const chunk of chunks) {
      if (!hostChunkKeys.has(`${chunk.takeId}:${chunk.sequence}`)) {
        throw new Error(`Saved chunk ${chunk.sequence + 1} was not found on the host. It was deleted from the guest device and cannot be sent again.`);
      }
    }
  }
  const chunkStates = new Map(reconciled.chunks.map((item) =>
    [`${item.takeId}:${item.sequence}`, item.hostStored]));
  const manifestStates = new Map(reconciled.manifests.map((item) =>
    [item.takeId, item.hostStored]));
  const transaction = database.transaction(['chunks', 'takes'], 'readwrite');
  const done = transactionComplete(transaction);
  const chunkCursor = transaction.objectStore('chunks').index('transferGeneration')
    .openCursor(IDBKeyRange.only(generation));
  chunkCursor.addEventListener('error', () => transaction.abort(), { once: true });
  chunkCursor.addEventListener('success', () => {
    const cursor = chunkCursor.result;
    if (!cursor) return;
    const chunk = cursor.value;
    const stored = chunkStates.get(`${chunk.takeId}:${chunk.sequence}`) === true;
    if (chunk.hostStored !== stored) cursor.update({ ...chunk, hostStored: stored });
    cursor.continue();
  });
  const takeCursor = transaction.objectStore('takes').index('transferGeneration')
    .openCursor(IDBKeyRange.only(generation));
  takeCursor.addEventListener('error', () => transaction.abort(), { once: true });
  takeCursor.addEventListener('success', () => {
    const cursor = takeCursor.result;
    if (!cursor) return;
    const take = cursor.value;
    if (!take.remote && manifestStates.has(take.id)) {
      const stored = manifestStates.get(take.id) === true;
      if (take.hostStored !== stored) cursor.update({ ...take, hostStored: stored });
    }
    cursor.continue();
  });
  await done;
  for (const chunk of reconciled.chunks) {
    if (chunk.hostStored) {
      await markTransferChunkStored(chunk.takeId, chunk.sequence, chunk.sha256);
    }
  }
  transferProgressCache = null;
}

async function getNextTransferManifest(generation) {
  const take = await findIndexValue('takes', 'transferGeneration', IDBKeyRange.only(generation), (take) =>
    take.status !== 'recording' && take.hostStored !== true && take.frames > 0 && take.chunks > 0
  );
  return take ? ensureTransferParticipant(take) : null;
}

async function hasPendingTransfer(generation) {
  if (!generation) return false;
  const pendingChunk = await findIndexValue(
    'chunks',
    'transferGeneration',
    IDBKeyRange.only(generation),
    (chunk) => !chunk.remote && chunk.hostStored !== true
  );
  return Boolean(pendingChunk) || Boolean(await findIndexValue(
      'takes',
      'transferGeneration',
      IDBKeyRange.only(generation),
      (take) => take.hostStored !== true
  ));
}

async function getTransferProgress(generation) {
  if (!generation || !roomCall?.localRole) return null;
  const role = roomCall.localRole;
  if (transferProgressCache?.generation === generation && transferProgressCache.role === role) {
    return {
      ...transferProgressCache,
      pending: role === 'guest'
        ? await hasPendingTransfer(generation)
        : transferProgressCache.totalTakes > transferProgressCache.completeTakes
    };
  }
  const range = IDBKeyRange.only(generation);
  const chunks = await findIndexValues(
    'chunks',
    'transferGeneration',
    range,
    (chunk) => chunk.transferGeneration === generation &&
      (role === 'guest' ? !chunk.remote : chunk.remote),
    (chunk) => ({
      takeId: chunk.takeId,
      sequence: chunk.sequence,
      bytes: chunk.byteLength ?? chunk.wav?.size,
      frames: chunk.frames,
      hostStored: chunk.hostStored === true
    })
  );
  if (role === 'guest') {
    const takesWithStoredChunks = await findIndexValues(
      'takes',
      'transferGeneration',
      range,
      (take) => take.transferGeneration === generation && !take.remote &&
        Array.isArray(take.hostStoredChunks) && take.hostStoredChunks.length > 0
    );
    const chunkKeys = new Set(chunks.map((chunk) => `${chunk.takeId}:${chunk.sequence}`));
    for (const take of takesWithStoredChunks) {
      for (const chunk of take.hostStoredChunks) {
        const key = `${take.id}:${chunk.sequence}`;
        if (chunkKeys.has(key)) continue;
        chunks.push({
          takeId: take.id,
          sequence: chunk.sequence,
          bytes: chunk.bytes,
          frames: chunk.frames,
          hostStored: true
        });
        chunkKeys.add(key);
      }
    }
  }
  const takes = role === 'host'
    ? await findIndexValues(
      'takes',
      'transferGeneration',
      IDBKeyRange.only(generation),
      (take) => Boolean(take.sourceTakeId),
      (take) => ({ hostStored: take.hostStored === true })
    )
    : [];
  transferProgressCache = {
    generation,
    role,
    ...summarizeTransferChunks(chunks),
    completeTakes: takes.filter((take) => take.hostStored).length,
    totalTakes: takes.length
  };
  return {
    ...transferProgressCache,
    pending: role === 'guest'
      ? await hasPendingTransfer(generation)
      : transferProgressCache.totalTakes > transferProgressCache.completeTakes
  };
}

function updateTransferProgressCache(generation, role, update) {
  if (transferProgressCache?.generation !== generation || transferProgressCache.role !== role) return;
  Object.assign(transferProgressCache, update(transferProgressCache));
}

function formatTransferMegabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatTransferRatio(untransferredBytes, totalBytes) {
  const total = Math.max(0, totalBytes);
  const untransferred = Math.min(total, Math.max(0, untransferredBytes));
  const completion = total > 0
    ? `${Math.round((1 - untransferred / total) * 100)}%`
    : '—';
  return `${formatTransferMegabytes(untransferred)} / ${formatTransferMegabytes(total)} · ${completion} complete`;
}

function drawTransferGraph(now) {
  const canvas = $('transferGraph');
  const context = canvas.getContext?.('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const left = 38;
  const right = width - 38;
  const top = 8;
  const bottom = height - 20;
  const maxMbps = Math.max(1.5, ...transferGraphSamples
    .map((sample) => sample.sendMbps)
    .filter(Number.isFinite));
  const y = (value) => bottom - Math.min(maxMbps, value) / maxMbps * (bottom - top);
  const percentY = (value) => bottom - Math.min(100, Math.max(0, value)) / 100 * (bottom - top);
  context.clearRect(0, 0, width, height);
  context.font = '10px sans-serif';
  context.fillStyle = '#aeb8c2';
  context.strokeStyle = '#303a44';
  context.lineWidth = 1;
  context.setLineDash([]);
  for (const [value, label] of [[0, '0%'], [50, '50%'], [100, '100%']]) {
    const lineY = percentY(value);
    context.beginPath();
    context.moveTo(left, lineY);
    context.lineTo(right, lineY);
    context.stroke();
    context.textAlign = 'left';
    context.fillText(`${(maxMbps * value / 100).toFixed(1)} Mbps`, 2, lineY + 3);
    context.textAlign = 'right';
    context.fillText(label, width - 2, lineY + 3);
  }
  context.textAlign = 'left';
  context.fillText('60 sec ago', left, height - 4);
  context.fillText('Now', right - 25, height - 4);

  for (const [key, color, valueY] of [
    ['sendMbps', '#59d6b2', y],
    ['savePercent', '#82aaff', percentY]
  ]) {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    let started = false;
    for (const sample of transferGraphSamples) {
      if (!Number.isFinite(sample[key])) {
        started = false;
        continue;
      }
      const x = left + Math.max(0, sample.at - (now - 60_000)) / 60_000 * (right - left);
      const pointY = valueY(sample[key]);
      if (started) context.lineTo(x, pointY);
      else context.moveTo(x, pointY);
      started = true;
    }
    context.stroke();
  }
}

function updateTransferGraph(now, sendMbps, savePercent) {
  transferGraphSamples.push({
    at: now,
    sendMbps: Number.isFinite(sendMbps) ? sendMbps : null,
    savePercent: Number.isFinite(savePercent) ? Math.min(100, Math.max(0, savePercent)) : null
  });
  transferGraphSamples = transferGraphSamples.filter((sample) => now - sample.at <= 60_000).slice(-61);
  drawTransferGraph(now);
  const sample = transferGraphSamples.at(-1);
  updateTransferGraphSummary(sample.sendMbps, sample.savePercent);
}

function updateTransferGraphSummary(sendMbps, savePercent) {
  const sendText = sendMbps === null ? '— Mbps' : `${sendMbps.toFixed(2)} Mbps`;
  const saveText = savePercent === null ? '—%' : `${Math.round(savePercent)}%`;
  $('transferUploadSummary').textContent = `Upload ${sendText}`;
  $('transferSaveRateSummary').textContent = `Save Rate ${saveText}`;
}

async function updateTransferProgress() {
  const card = $('transferProgressCard');
  const text = $('transferProgressText');
  const generation = roomCall?.authFields?.generation;
  if (!roomCall?.localRole || !generation) {
    card.classList.remove('transfer-error');
    transferGraphSamples = [];
    text.textContent = '— / — · — complete';
    $('networkProgressError').textContent = '—';
    $('networkProgressErrorRow').hidden = true;
    drawTransferGraph(performance.now());
    updateTransferGraphSummary(null, null);
    return;
  }
  const progress = await getTransferProgress(generation);
  if (!progress) return;
  if (card.classList.contains('transfer-error')) {
    card.classList.remove('transfer-error');
    $('networkProgressError').textContent = '—';
    $('networkProgressErrorRow').hidden = true;
  }
  const now = performance.now();
  if (progress.role === 'guest') {
    const sending = roomCall.recordingTransfer.getSendProgress();
    const backlog = splitTransferBacklog(progress.pendingBytes, sending);
    const sendMbps = roomCall.transferSendMbps;
    roomCall.reportTransferProgress({
      localBytes: progress.bytes,
      hostStoredBytes: progress.hostStoredBytes,
      pendingBytes: progress.pendingBytes,
      totalFrames: progress.frames,
      hostStoredFrames: progress.hostStoredFrames,
      pendingFrames: progress.pendingFrames,
      ...backlog,
      sendState: sending.state,
      bufferedBytes: sending.bufferedBytes,
      sendMbps
    });
    const totalStored = progress.bytes > 0
      ? Math.min(1, progress.hostStoredBytes / progress.bytes)
      : 0;
    updateTransferGraph(now, sendMbps, totalStored * 100);
    text.textContent = formatTransferRatio(progress.pendingBytes, progress.bytes);
    return;
  }

  const guestProgress = roomCall.remoteTransferProgress;
  const guestIsFresh = guestProgress && now - guestProgress.receivedAt <= 6_000;
  const guestTotalBytes = guestIsFresh ? guestProgress.localBytes : 0;
  const savePercent = guestIsFresh
    ? guestTotalBytes > 0 ? Math.min(100, progress.bytes / guestTotalBytes * 100) : 0
    : null;
  updateTransferGraph(now, guestIsFresh ? guestProgress.sendMbps : null, savePercent);
  text.textContent = guestIsFresh
    ? formatTransferRatio(Math.max(0, guestTotalBytes - progress.bytes), guestTotalBytes)
    : '— / — · — complete';
}

async function markTransferManifestStored(takeId) {
  const transaction = database.transaction('takes', 'readwrite');
  const done = transactionComplete(transaction);
  const store = transaction.objectStore('takes');
  const request = store.get(takeId);
  request.addEventListener('success', () => {
    const take = request.result;
    if (!take) {
      transaction.abort();
      return;
    }
    store.put({ ...take, hostStored: true });
  }, { once: true });
  await done;
  await renderTakes();
}

function incomingTakeId(generation, takeId) {
  return `remote-${generation}-${takeId}`;
}

async function storeIncomingTransferChunk(metadata, wav, sha256) {
  if (roomCall?.localRole !== 'host' || !activeSession ||
      metadata.generation !== roomCall.authFields?.generation) {
    throw new Error('The session or connection for the received take does not match.');
  }
  const takeId = incomingTakeId(metadata.generation, metadata.takeId);
  const existingTake = await runRequest('takes', 'get', takeId);
  const existingChunk = await runRequest('chunks', 'get', [takeId, metadata.sequence]);
  if (existingChunk) {
    if (!existingTake || existingChunk.sha256 !== sha256 ||
        existingChunk.startFrame !== metadata.startFrame || existingChunk.frames !== metadata.frames ||
        existingTake.participant !== metadata.participant || existingTake.number !== metadata.takeNumber ||
        existingTake.startedAt !== metadata.startedAt || !sameStartPlan(existingTake.startPlan, metadata.startPlan)) {
      throw new Error('Different audio hashes were received for the same chunk number.');
    }
    try {
      await verifyIncomingStoredChunk(existingTake, existingChunk, metadata.sequence, metadata.startFrame);
    } catch {
      const repairedChunk = {
        ...existingChunk,
        byteLength: wav.size,
        wav,
        committedAt: Date.now()
      };
      await verifyIncomingStoredChunk(existingTake, repairedChunk, metadata.sequence, metadata.startFrame);
      const transaction = database.transaction('chunks', 'readwrite');
      const done = transactionComplete(transaction);
      transaction.objectStore('chunks').put(repairedChunk);
      await done;
    }
    return;
  }
  let totalReceivedFrames = receivedTransferFrames.get(metadata.generation);
  if (!existingTake || existingTake.status === 'recording') {
    if (totalReceivedFrames === undefined) {
      totalReceivedFrames = (await loadAll('takes'))
        .filter((item) => item.remote && item.transferGeneration === metadata.generation)
        .reduce((total, item) => total + item.frames, 0);
    }
    if (totalReceivedFrames + metadata.frames > MAX_SESSION_FRAMES) {
      throw new Error('Received audio from this participant exceeds the 2-hour limit.');
    }
  }
  const synchronization = synchronizationForTake({
    ...existingTake,
    sessionId: activeSession.id,
    startPlan: metadata.startPlan ?? null
  }, await loadAll('takes'));
  const take = existingTake || {
    synchronization,
    id: takeId,
    sessionId: activeSession.id,
    sourceTakeId: metadata.takeId,
    transferGeneration: metadata.generation,
    participant: metadata.participant,
    number: metadata.takeNumber,
    startedAt: metadata.startedAt,
    startPlan: metadata.startPlan ?? null,
    startObservation: null,
    captureStatus: 'unconfirmed',
    startedAtEstimated: metadata.startedAtEstimated === true,
    endedAt: null,
    status: 'recording',
    frames: 0,
    chunks: 0,
    bytes: 0,
    tailUnknown: false,
    remote: true,
    hostStored: false,
    sessionName: activeSession.name
  };
  const takeStillRecording = take.status === 'recording' &&
    metadata.sequence === take.chunks && metadata.startFrame === take.frames;
  const validChunkPosition = takeStillRecording ||
    ['recording', 'stopped', 'recovered'].includes(take.status) &&
      metadata.sequence < take.chunks && metadata.startFrame + metadata.frames <= take.frames;
  if (take.sessionId !== activeSession.id || take.sourceTakeId !== metadata.takeId ||
      take.transferGeneration !== metadata.generation || take.participant !== metadata.participant ||
      take.number !== metadata.takeNumber || take.startedAt !== metadata.startedAt ||
      !sameStartPlan(take.startPlan, metadata.startPlan) ||
      Boolean(take.startedAtEstimated) !== Boolean(metadata.startedAtEstimated) ||
      !validChunkPosition) {
    throw new Error('The received chunk does not match the existing take order or metadata.');
  }
  const chunk = {
    takeId,
    sourceTakeId: metadata.takeId,
    transferGeneration: metadata.generation,
    sequence: metadata.sequence,
    startFrame: metadata.startFrame,
    frames: metadata.frames,
    byteLength: wav.size,
    wav,
    sha256,
    committedAt: Date.now(),
    remote: true,
    hostStored: true
  };
  await verifyIncomingStoredChunk(take, chunk, metadata.sequence, metadata.startFrame);
  const nextTake = takeStillRecording
    ? {
      ...take,
      frames: take.frames + metadata.frames,
      chunks: take.chunks + 1,
      bytes: take.bytes + wav.size
    }
    : take;
  const stores = takeStillRecording ? ['chunks', 'takes'] : ['chunks'];
  const transaction = database.transaction(stores, 'readwrite');
  const done = transactionComplete(transaction);
  transaction.objectStore('chunks').put(chunk);
  if (takeStillRecording) {
    const store = transaction.objectStore('takes');
    const request = store.get(takeId);
    request.addEventListener('success', () => {
      store.put({ ...nextTake, synchronization: request.result?.synchronization ?? synchronization });
    }, { once: true });
  }
  await done;
  if (takeStillRecording) {
    receivedTransferFrames.set(metadata.generation, totalReceivedFrames + metadata.frames);
  }
  if (metadata.startedAtEstimated && metadata.sequence === 0 && !existingTake) {
    appendNetworkEvent(
      'Guest recording start time estimated',
      'the displayed take timing may be approximate'
    );
  }
  updateTransferProgressCache(metadata.generation, 'host', (progress) => ({
    bytes: progress.bytes + wav.size,
    frames: progress.frames + metadata.frames,
    hostStoredBytes: progress.hostStoredBytes + wav.size,
    hostStoredFrames: progress.hostStoredFrames + metadata.frames,
    totalTakes: progress.totalTakes + (existingTake ? 0 : 1)
  }));
  scheduleTakeRefresh();
}

async function storeIncomingTransferManifest(manifest) {
  if (roomCall?.localRole !== 'host' || !activeSession ||
      manifest.generation !== roomCall.authFields?.generation) {
    throw new Error('The session or connection for the received manifest does not match.');
  }
  const takeId = incomingTakeId(manifest.generation, manifest.takeId);
  const take = await runRequest('takes', 'get', takeId);
  if (!take || take.frames !== manifest.frames || take.chunks !== manifest.chunks ||
      take.sourceTakeId !== manifest.takeId || take.participant !== manifest.participant ||
      take.startedAt !== manifest.startedAt || take.number !== manifest.takeNumber ||
      !sameStartPlan(take.startPlan, manifest.startPlan) ||
      Boolean(take.startedAtEstimated) !== Boolean(manifest.startedAtEstimated)) {
    throw new Error('The manifest does not match the chunks saved on the host.');
  }
  const savedChunks = await loadTakeChunks(takeId);
  await verifyIncomingStoredTake(take, savedChunks);
  if (take.hostStored) {
    return;
  }
  const nextTake = {
    ...take,
    status: manifest.status,
    endedAt: manifest.startedAt === null ? null : manifest.startedAt + (manifest.frames / TARGET_RATE) * 1000,
    startObservation: manifest.startObservation ?? null,
    timingPoints: manifest.timingPoints ?? [],
    timingDiscontinuous: Boolean(manifest.timingDiscontinuous),
    captureStatus: manifest.startObservation ? 'started' : 'unconfirmed',
    tailUnknown: manifest.tailUnknown,
    startedAtEstimated: manifest.startedAtEstimated === true,
    hostStored: true
  };
  const transaction = database.transaction('takes', 'readwrite');
  const done = transactionComplete(transaction);
  const store = transaction.objectStore('takes');
  const request = store.get(takeId);
  request.addEventListener('success', () => {
    if (!request.result) { transaction.abort(); return; }
    store.put({ ...nextTake, synchronization: request.result.synchronization ?? nextTake.synchronization });
  }, { once: true });
  await done;
  updateTransferProgressCache(manifest.generation, 'host', (progress) => ({
    completeTakes: progress.completeTakes + 1
  }));
  await renderTakes();
}

async function updateSessionSavedSize() {
  const saved = activeSession
    ? (await loadAll('takes')).filter((take) => take.sessionId === activeSession.id).reduce((total, take) => total + (take.bytes || 0), 0)
    : 0;
  $('sessionSaved').textContent = `${(saved / 1_000_000).toFixed(2)} MB`;
}

function scheduleTakeRefresh() {
  if (takeRefreshTimer !== null) return;
  takeRefreshTimer = window.setTimeout(() => {
    takeRefreshTimer = null;
    void (async () => {
      await renderTakes();
      await updateSessionSavedSize();
    })().catch((error) => {
      errorText.textContent = `Unable to refresh the recording list: ${error.message}`;
    });
  }, 2000);
}

async function refreshSessionList() {
  const sessions = (await loadAll('sessions')).sort((left, right) => right.createdAt - left.createdAt);
  const takes = await loadAll('takes');
  const takesBySession = new Map();
  for (const take of takes) {
    const sessionTakes = takesBySession.get(take.sessionId) || [];
    sessionTakes.push(take);
    takesBySession.set(take.sessionId, sessionTakes);
  }
  const guestMode = roomCall?.isGuest === true;
  const visibleSessions = guestMode
    ? sessions.filter((session) => isGuestLocalSession(session, takesBySession.get(session.id) || []))
    : sessions;
  const visibleSessionIds = new Set(visibleSessions.map((session) => session.id));
  for (const sessionId of selectedSessionIds) {
    if (!visibleSessionIds.has(sessionId)) selectedSessionIds.delete(sessionId);
  }
  const deleteSelectedSessionsButton = $('deleteSelectedSessionsButton');
  deleteSelectedSessionsButton.hidden = visibleSessions.length === 0;
  deleteSelectedSessionsButton.disabled = deletingSession || Boolean(activeSession) ||
    Boolean(roomCall?.isActive) || selectedSessionIds.size === 0;
  deleteSelectedSessionsButton.textContent = 'Delete Sessions';
  deleteSelectedSessionsButton.title = guestMode
    ? 'Deleting selected recordings that are not saved on the host will permanently remove audio stored only on this device.'
    : '';
  sessionList.replaceChildren();
  if (!visibleSessions.length) {
    sessionList.innerHTML = guestMode
      ? '<p class="empty-state">No guest recordings are saved on this device.</p>'
      : '<p class="empty-state">No saved sessions.</p>';
    return;
  }
  for (const session of visibleSessions) {
    const sessionTakes = takesBySession.get(session.id) || [];
    const row = document.createElement('div');
    row.className = 'session-entry';
    const info = document.createElement('div');
    info.className = 'session-entry-info';
    const name = document.createElement('p');
    name.className = 'session-entry-name';
    name.textContent = session.name;
    const meta = document.createElement('p');
    meta.className = 'session-entry-meta';
    const totalBytes = sessionTakes.reduce((sum, take) => sum + (take.bytes || 0), 0);
    const stored = guestTakesAreStored(sessionTakes);
    meta.textContent = guestMode
      ? `${session.participant} · ${sessionTakes.length} takes · ${formatBytes(totalBytes)} · ${stored ? 'Saved on host' : 'Unsaved audio'}`
      : `${session.participant} · ${sessionTakes.length} take · ${formatBytes(totalBytes)}`;
    info.append(name, meta);
    const selectionLabel = document.createElement('label');
    selectionLabel.className = 'session-selection';
    const selection = document.createElement('input');
    selection.type = 'checkbox';
    selection.checked = selectedSessionIds.has(session.id);
    selection.setAttribute('aria-label', `Select ${session.name} for deletion`);
    selection.addEventListener('change', () => {
      if (selection.checked) selectedSessionIds.add(session.id);
      else selectedSessionIds.delete(session.id);
      deleteSelectedSessionsButton.disabled = deletingSession || Boolean(activeSession) ||
        Boolean(roomCall?.isActive) || selectedSessionIds.size === 0;
    });
    selectionLabel.append(selection);
    if (guestMode) {
      row.append(selectionLabel, info);
    } else {
      const openButton = document.createElement('button');
      openButton.className = 'session-open';
      openButton.type = 'button';
      openButton.textContent = 'Open →';
      openButton.addEventListener('click', () => { void openSession(session); });
      row.append(selectionLabel, info, openButton);
    }
    sessionList.append(row);
  }
}

function isGuestLocalSession(session, takes) {
  return session.guestSession === true ||
    takes.some((take) => !take.remote && Boolean(take.transferGeneration));
}

async function deleteSelectedSessions() {
  if (deletingSession || activeSession || roomCall?.isActive) return;
  deletingSession = true;
  try {
    const sessions = await loadAll('sessions');
    const takes = await loadAll('takes');
    const takesBySession = new Map();
    for (const take of takes) {
      const sessionTakes = takesBySession.get(take.sessionId) || [];
      sessionTakes.push(take);
      takesBySession.set(take.sessionId, sessionTakes);
    }
    const guestMode = roomCall?.isGuest === true;
    const selectedSessions = sessions
      .filter((session) => selectedSessionIds.has(session.id) &&
        (!guestMode || isGuestLocalSession(session, takesBySession.get(session.id) || [])))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!selectedSessions.length) {
      $('statusMessage').textContent = 'Select sessions to delete.';
      return;
    }
    const unconfirmedCount = selectedSessions.filter((session) =>
      !guestTakesAreStored(takesBySession.get(session.id) || [])).length;
    const selectedIds = selectedSessions
      .map((session) => session.id);
    const warning = guestMode && unconfirmedCount > 0
      ? `\n\n${unconfirmedCount} selected session(s) contain audio not saved on the host. Deleting them will permanently remove audio stored only on this device.`
      : '';
    const prompt = guestMode
      ? `Delete guest recordings from ${selectedIds.length} selected session(s) on this device. Audio already saved on the host will not be deleted.${warning}\n\nThis action cannot be undone.`
      : `Delete ${selectedIds.length} selected session(s) and all recordings and received audio saved in them. This action cannot be undone.`;
    if (!window.confirm(prompt)) return;
    await deleteSessionsAndRecordings(selectedIds);
    for (const sessionId of selectedIds) selectedSessionIds.delete(sessionId);
    $('statusMessage').textContent = '';
  } catch (error) {
    $('statusMessage').textContent = `Unable to delete the selected sessions: ${error.message}`;
  } finally {
    deletingSession = false;
    try {
      await refreshSessionList();
    } catch (error) {
      $('statusMessage').textContent = `Unable to refresh the session list: ${error.message}`;
    }
  }
}

async function renderTakes() {
  if (!activeSession) return;
  const takes = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id)
    .sort((left, right) => left.startedAt - right.startedAt);
  takeList.replaceChildren();
  if (!takes.length) {
    takeList.innerHTML = '<p class="empty-state">Your recorded takes will appear here.</p>';
    return;
  }
  for (const take of takes) {
    const row = document.createElement('article');
    row.className = 'take-row';
    const info = document.createElement('div');
    info.className = 'take-info';
    const label = document.createElement('span');
    label.className = 'take-title';
    const participant = take.participant || activeSession.participant;
    label.textContent = `${participant} ${String(take.number).padStart(2, '0')}`;
    const meta = document.createElement('p');
    meta.className = 'take-meta';
    const duration = formatDuration((take.frames || 0) / TARGET_RATE);
    const size = Number.isFinite(take.bytes) ? formatBytes(take.bytes) : '—';
    const synchronization = synchronizationForTake(take, takes);
    const timing = synchronization
      ? `Start difference ${synchronization.differenceMs.toFixed(1)} ms`
      : take.startPlan
        ? 'Synchronization unconfirmed'
        : take.startObservation ? 'Start observed' : 'Start unconfirmed';
    const delivery = take.remote || take.transferGeneration
      ? take.hostStored ? 'Saved on host' : 'Transfer pending'
      : 'Saved locally';
    meta.textContent = `${duration} · ${size} · ${timing} · ${delivery}`;
    info.append(label, meta);
    const actions = document.createElement('div');
    actions.className = 'take-actions';
    if (roomCall?.isGuest !== true) {
      const exportButton = document.createElement('button');
      exportButton.className = 'take-action';
      exportButton.type = 'button';
      exportButton.textContent = take.status === 'recovered' ? 'Save Recovered WAV' : 'Save WAV';
      exportButton.disabled = take.status === 'recording' || !take.chunks ||
        (take.remote && take.hostStored !== true);
      exportButton.addEventListener('click', () => { void exportTake(take, exportButton); });
      actions.append(exportButton);
      if (!take.remote) {
        meta.textContent += ' · Host reference (unchanged)';
      } else {
        const reference = takes.find((item) => !item.remote && item.startPlan?.eventId === take.startPlan?.eventId &&
          item.startPlan?.sequence === take.startPlan?.sequence);
        const alignment = assessAlignment(take, reference);
        const alignedButton = document.createElement('button');
        alignedButton.className = 'take-action';
        alignedButton.type = 'button';
        alignedButton.textContent = 'Save aligned WAV (experimental)';
        alignedButton.disabled = exportButton.disabled || !alignment.available;
        alignedButton.title = alignment.available
          ? `Drift ${alignment.driftPpm.toFixed(1)} ppm · estimated uncertainty ${alignment.uncertaintyMs.toFixed(1)} ms`
          : alignment.reason;
        alignedButton.addEventListener('click', () => { void exportTake(take, alignedButton, alignment); });
        actions.append(alignedButton);
        meta.textContent += alignment.available
          ? ` · Drift ${alignment.driftPpm.toFixed(1)} ppm (experimental)`
          : ` · Alignment unavailable: ${alignment.reason}`;
      }
    }
    row.append(info, actions);
    takeList.append(row);
  }
}

async function openSession(session) {
  if (roomCall?.isGuest && roomCall.remoteSessionName) {
    session.name = roomCall.remoteSessionName;
  }
  activeSession = session;
  updateRecordButtonAvailability();
  $('studioTitle').value = session.name;
  const guestView = roomCall?.isGuest === true;
  $('studioTitle').hidden = guestView;
  $('studioTitle').readOnly = guestView;
  $('guestStudioTitle').textContent = session.name;
  $('guestStudioTitle').hidden = !guestView;
  studioTitleSaveFailed = false;
  $('participantLabel').textContent = session.participant;
  $('waveformParticipant').textContent = session.participant;
  stopWaveformRendering();
  $('timer').textContent = '00:00';
  setupView.hidden = true;
  studioView.hidden = false;
  $('waveformState').textContent = '';
  $('waveformState').classList.remove('live');
  errorText.textContent = '';
  if (roomCall?.isGuest && roomCall.remoteSessionName) {
    try {
      await persistSession({ ...session });
    } catch (error) {
      errorText.textContent = `Unable to save the session name received from the host: ${error.message}`;
    }
  } else {
    roomCall?.setSessionName(session.name);
  }
  setStatus('Ready to start recording');
  await renderTakes();
  const takes = (await loadAll('takes'))
    .filter((take) => take.sessionId === session.id)
    .sort((left, right) => left.startedAt - right.startedAt);
  const savedFrames = takes.filter((take) => !take.remote)
    .reduce((total, take) => total + (take.frames || 0), 0);
  sessionLimitReached = savedFrames >= MAX_SESSION_FRAMES;
  updateRecordButtonAvailability();
  if (sessionLimitReached) setStatus('This session has reached the 2-hour recording limit.');
  $('chunkCount').textContent = String(takes.at(-1)?.chunks || 0);
  await updateSessionSavedSize();
  if (!recording && !starting) {
    try {
      const stream = await ensureCaptureStream();
      if (activeSession === session && !studioView.hidden) startLocalPreview(stream);
      else if (!activeSession && !roomCall?.isActive) await releaseCaptureStream();
    } catch (error) {
      if (activeSession === session) {
        setLocalWaveformState('Waiting for microphone');
        errorText.textContent = `Unable to start the microphone waveform: ${error.message}`;
      }
    }
  }
}

async function deleteActiveSession() {
  const session = activeSession;
  if (!session || roomCall?.isGuest || $('deleteSessionButton').disabled) return;
  if (!window.confirm(
    `Delete "${session.name}" and all recordings and received audio saved in this session. This action cannot be undone.`
  )) return;
  if (!await saveStudioSessionName()) return;

  deletingSession = true;
  updateRecordButtonAvailability();
  let deleted = false;
  try {
    await deleteSessionAndRecordings(session.id);
    deleted = true;
    stopLocalPreview();
    await releaseCaptureStream();
    activeSession = null;
    sessionLimitReached = false;
    transferProgressCache = null;
    transferGraphSamples = [];
    studioView.hidden = true;
    setupView.hidden = false;
    await refreshSessionList();
    await updateSessionSavedSize();
    setMessage('Session and recordings deleted.');
  } catch (error) {
    errorText.textContent = deleted
      ? `Session deleted, but the view could not be refreshed: ${error.message}`
      : `Unable to delete the session: ${error.message}`;
  } finally {
    deletingSession = false;
    updateRecordButtonAvailability();
  }
}

async function detectDevices(requestPermission = true) {
  if (detectingDevices || switchingMicrophone) return;
  const button = $('detectDevices');
  detectingDevices = true;
  updateRecordButtonAvailability();
  button.disabled = true;
  button.textContent = 'Detecting…';
  $('statusMessage').textContent = '';
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Unable to list devices. Open this page over HTTPS or localhost.');
    if (requestPermission) {
      if (!navigator.mediaDevices.getUserMedia) throw new Error('Microphone access is not supported. Use Chrome or Edge.');
      const temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      temporaryStream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    const selectedDevice = micDevice.value;
    const selectedLabel = micDevice.selectedOptions[0]?.textContent;
    micDevice.replaceChildren();
    if (!microphones.length) {
      micDevice.add(new Option('No microphone found', ''));
      $('statusMessage').textContent = 'No available microphone was found.';
    } else {
      for (const [index, device] of microphones.entries()) {
        micDevice.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId));
      }
      if (microphones.some((device) => device.deviceId === selectedDevice)) micDevice.value = selectedDevice;
    }
    if (selectedDevice && !microphones.some((device) => device.deviceId === selectedDevice) && mediaStream) {
      micDevice.add(new Option(`${selectedLabel || 'Selected microphone'} (not connected)`, selectedDevice));
      micDevice.value = selectedDevice;
    }
  } catch (error) {
    $('statusMessage').textContent = error.name === 'NotAllowedError'
      ? 'Microphone access was denied. Check your browser site settings.'
      : `Unable to detect devices: ${error.message}`;
  } finally {
    trackMicDevice.replaceChildren(...Array.from(micDevice.options, (option) => option.cloneNode(true)));
    trackMicDevice.value = micDevice.value;
    detectingDevices = false;
    updateRecordButtonAvailability();
    button.disabled = false;
    button.textContent = 'Detect Devices';
  }
}

async function ensureCaptureStream() {
  if (mediaStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
    return mediaStream;
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is not supported. Use Chrome or Edge.');
  mediaStream = await acquireMicrophoneStream(micDevice.value);
  return mediaStream;
}

async function acquireMicrophoneStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      ...RAW_AUDIO_CONSTRAINTS,
      sampleRate: TARGET_RATE
    }
  });
}

async function changeMicrophone() {
  const previousDevice = micDevice.value;
  const deviceId = trackMicDevice.value;
  if (trackMicDevice.disabled || !deviceId || deviceId === previousDevice) {
    trackMicDevice.value = previousDevice;
    return;
  }
  switchingMicrophone = true;
  updateRecordButtonAvailability();
  $('trackMicDeviceHint').textContent = 'Switching microphone…';
  let nextStream = null;
  try {
    if (roomCall?.connected) await roomCall.checkLocalReadiness();
    nextStream = await acquireMicrophoneStream(deviceId);
    for (const track of nextStream.getAudioTracks()) track.enabled = !microphoneMuted;
    if (roomCall?.connected) await roomCall.attachLocalAudio(nextStream);
    const previousStream = mediaStream;
    mediaStream = nextStream;
    nextStream = null;
    micDevice.value = deviceId;
    startLocalPreview(mediaStream);
    previousStream?.getTracks().forEach((track) => track.stop());
    $('trackMicDeviceHint').textContent = 'Microphone changed.';
  } catch (error) {
    nextStream?.getTracks().forEach((track) => track.stop());
    trackMicDevice.value = previousDevice;
    $('trackMicDeviceHint').textContent = `Unable to change microphone: ${error.message}`;
  } finally {
    switchingMicrophone = false;
    updateRecordButtonAvailability();
    if (roomCall?.connected) await roomCall.checkLocalReadiness();
  }
}

async function checkRecordingReadiness() {
  if (switchingMicrophone) throw new Error('The microphone is being switched.');
  const stream = mediaStream || await ensureCaptureStream();
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live' || track.muted) {
    throw new Error('No active microphone input is available.');
  }
  if (!window.AudioContext) throw new Error('AudioContext is not available.');
  const context = new AudioContext({ sampleRate: TARGET_RATE });
  try {
    if (context.sampleRate !== TARGET_RATE) throw new Error('Unable to create a 48 kHz AudioContext.');
    await context.audioWorklet.addModule('./recorder-worklet.js');
  } finally {
    if (context.state !== 'closed') await context.close();
  }

  const probeId = `readiness-${crypto.randomUUID()}`;
  const transaction = database.transaction('sessions', 'readwrite');
  const done = transactionComplete(transaction);
  const sessions = transaction.objectStore('sessions');
  sessions.put({ id: probeId });
  sessions.delete(probeId);
  await done;
  return true;
}

async function releaseCaptureStream() {
  if (recording) return;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  updateMicrophoneMuteButton();
}

async function commitChunk(samples, isFinal, startFrame) {
  if (!activeTake || samples.length === 0) return;
  if (startFrame !== capturedFrames) {
    throw new Error(`Recording frames are discontinuous (expected ${capturedFrames} / received ${startFrame}). Recording stopped rather than treating the unknown interval as valid audio.`);
  }
  if (!canQueueRecordingCommit(pendingCommits, isFinal)) {
    throw new Error('The IndexedDB save queue has reached 60 seconds. Recording stopped to prevent data loss.');
  }
  const sequence = nextSequence++;
  capturedFrames += samples.length;
  const wav = createPcm24Wav(samples);
  const chunk = {
    takeId: activeTake.id,
    sequence,
    startFrame,
    frames: samples.length,
    byteLength: wav.size,
    wav,
    transferGeneration: activeTake.transferGeneration,
    hostStored: activeTake.transferGeneration ? false : null,
    final: isFinal,
    committedAt: Date.now()
  };
  pendingCommits += 1;
  commitChain = commitChain.then(async () => {
    const transaction = database.transaction(['chunks', 'takes'], 'readwrite');
    const done = transactionComplete(transaction);
    transaction.objectStore('chunks').put(chunk);
    let committedTake;
    const storedTakeRequest = transaction.objectStore('takes').get(chunk.takeId);
    storedTakeRequest.addEventListener('success', () => {
      const storedTake = storedTakeRequest.result;
      if (!storedTake || activeTake?.id !== chunk.takeId) { transaction.abort(); return; }
      committedTake = {
        ...mergeRecordingMetadata(storedTake, activeTake),
        frames: storedTake.frames + samples.length,
        chunks: storedTake.chunks + 1,
        bytes: storedTake.bytes + wav.size
      };
      transaction.objectStore('takes').put(committedTake);
    }, { once: true });
    await done;
    if (activeTake?.id === committedTake.id) activeTake = mergeRecordingMetadata(committedTake, activeTake);
  }).catch((error) => {
    commitError = error;
    throw error;
  }).finally(() => {
    pendingCommits -= 1;
  });
  await commitChain;
  const take = activeTake;
  if (!take) throw new Error('The saved recording take was not found.');
  if (chunk.transferGeneration) {
    updateTransferProgressCache(chunk.transferGeneration, 'guest', (progress) => ({
      bytes: progress.bytes + wav.size,
      frames: progress.frames + samples.length,
      pendingBytes: progress.pendingBytes + wav.size,
      pendingFrames: progress.pendingFrames + samples.length
    }));
  }
  $('chunkCount').textContent = String(take.chunks);
  scheduleTakeRefresh();
  roomCall?.notifyChunkCommitted(chunk, take);
}

function queueRecordingMetadata(patch) {
  const update = { id: activeTake?.id, ...patch };
  if (!update.id) return;
  commitChain = commitChain.then(async () => {
    try {
      const transaction = database.transaction('takes', 'readwrite');
      const done = transactionComplete(transaction);
      const store = transaction.objectStore('takes');
      const request = store.get(update.id);
      request.addEventListener('success', () => {
        if (!request.result) { transaction.abort(); return; }
        store.put(mergeRecordingMetadata(request.result, update));
      }, { once: true });
      await done;
    } catch (error) {
      appendNetworkEvent('Recording metadata save failed', error.message);
      if (activeTake?.id === update.id) activeTake.timingDiscontinuous = true;
    }
  });
}

function recordTimingPoint(data) {
  if (!activeTake || !audioContext) return;
  const timestamp = audioContext.getOutputTimestamp?.();
  if (!timestamp || !Number.isFinite(timestamp.performanceTime) || timestamp.performanceTime <= 0 ||
      !Number.isFinite(timestamp.contextTime) || timestamp.contextTime <= 0) {
    activeTake.timingDiscontinuous = true;
    queueRecordingMetadata({ timingDiscontinuous: true });
    appendNetworkEvent('Recording timing unavailable', `frame=${data.frame} output timestamp unavailable`);
    return;
  }
  const point = {
    frame: data.frame,
    contextTime: data.contextTime,
    localPerfMs: timestamp.performanceTime + (data.contextTime - timestamp.contextTime) * 1000,
    uncertaintyMs: 1
  };
  const points = activeTake.timingPoints ?? [];
  if (points.length >= MAX_TIMING_POINTS || points.at(-1)?.frame >= point.frame) return;
  activeTake.timingPoints = [...points, point];
  queueRecordingMetadata({ timingPoints: activeTake.timingPoints });
}

async function createTake({
  scheduledStartAt = null,
  scheduledStartedAt = null,
  event = null,
  prepareOnly = false,
  preparedAudioContext = null,
  preparedAudioContextResume = null
} = {}) {
  errorText.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('AudioWorklet recording is not supported. Use Chrome or Edge.');
  }
  await stopDiagnostics({ stopCapture: !roomCall?.isActive });
  await ensureCaptureStream();
  const reusePreviewContext = previewAudioContext === preparedAudioContext;
  stopLocalPreview({ preserveAudioContext: reusePreviewContext });
  audioContext = preparedAudioContext || new AudioContext({ sampleRate: TARGET_RATE });
  if (primedRecordingAudioContext === audioContext) {
    primedRecordingAudioContext = null;
    primedRecordingAudioContextResume = null;
    primedRecordingAudioContextAnchor = null;
  }
  if (audioContext.sampleRate !== TARGET_RATE) {
    throw new Error(`This device’s AudioContext is ${audioContext.sampleRate} Hz. 48,000 Hz is required.`);
  }
  const sessionTakes = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id && !take.remote);
  const savedFrames = sessionTakes.reduce((total, take) => total + (take.frames || 0), 0);
  takeFrameLimit = remainingSessionFrames(savedFrames);
  if (takeFrameLimit === 0) {
    sessionLimitReached = true;
    updateRecordButtonAvailability();
    throw new Error('This session has reached the 2-hour recording limit. Create a new session.');
  }
  sessionLimitReached = false;
  activeTake = {
    id: crypto.randomUUID(),
    sessionId: activeSession.id,
    number: sessionTakes.length + 1,
    participant: activeSession.participant,
    status: prepareOnly ? 'preparing' : 'recording',
    transferGeneration: roomCall?.localRole === 'guest' ? roomCall.authFields?.generation : null,
    hostStored: roomCall?.localRole === 'guest' ? false : null,
    startedAt: prepareOnly ? null : scheduledStartedAt ??
      (scheduledStartAt === null ? Date.now() : Date.now() + (scheduledStartAt - performance.now())),
    endedAt: null,
    frames: 0,
    chunks: 0,
    bytes: 0,
    tailUnknown: false
  };
  nextSequence = 0;
  capturedFrames = 0;
  $('chunkCount').textContent = '0';
  lastPeak = 0;
  resetWaveformHistory(localWaveform, null);
  waveformElapsedSeconds = 0;
  updateMeter(0);
  pendingCommits = 0;
  commitError = null;
  commitChain = Promise.resolve();
  finalizing = false;

  await audioContext.audioWorklet.addModule('./recorder-worklet.js');
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.65;
  waveformSamples = new Float32Array(analyserNode.fftSize);
  recorderNode = new AudioWorkletNode(audioContext, 'perfectpodcast-local-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit'
  });
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  recorderNode.port.onmessage = ({ data }) => {
    if (data.type === 'started') {
      if (!recording || finalizing) return;
      captureOnAir = true;
      captureStartPending = false;
      updateCaptureStatusBadge();
      const timestamp = audioContext?.getOutputTimestamp?.();
      const observedAt = timestamp && Number.isFinite(timestamp.performanceTime) &&
        Number.isFinite(timestamp.contextTime)
        ? timestamp.performanceTime + (data.contextTime - timestamp.contextTime) * 1000
        : performance.now() + (data.contextTime - (audioContext?.currentTime ?? data.contextTime)) * 1000;
      if (data.event) {
        roomCall?.reportRecordingStarted(data.event, observedAt, data.frame);
      } else {
        appendNetworkEvent(
          'Recording start local',
          `frame=${data.frame} observedAt=${observedAt.toFixed(3)} ms`
        );
      }
      takeStartedAt = observedAt;
      recordTimingPoint(data);
      roomCall?.startDriftMonitoring();
      activeTake.startObservation = { frame: data.frame, localPerfMs: observedAt, contextTime: data.contextTime };
      activeTake.captureStatus = 'started';
      queueRecordingMetadata({ startObservation: activeTake.startObservation });
      resetWaveformHistory(localWaveform, observedAt, observedAt);
      waveformElapsedSeconds = 0;
      roomCall?.beginRecordingWaveform(observedAt);
      scheduledRecordingStartAt = null;
      scheduledRecordingWallStartAt = null;
      updateRecordingPreparation();
      setStatus('Recording · Saving to this device', 'recording');
      if (roomCall?.isGuest) $('hostRecordingStatus').textContent = 'Recording in sync with the host';
      $('waveformState').textContent = 'LIVE';
      $('waveformState').classList.add('live');
      drawWaveform();
      return;
    }
    if (data.type === 'timing') {
      if (recording && !finalizing) recordTimingPoint(data);
      return;
    }
    if (data.type === 'level') {
      updateMeter(data.peak);
      return;
    }
    if (data.type === 'audio') {
      if (commitError) return;
      void commitChunk(data.samples, data.final, data.startFrame).catch((error) => {
        errorText.textContent = error.message || `Unable to save chunk: ${error}`;
        void stopRecording(errorText.textContent);
      });
      return;
    }
    if (data.type === 'limit-reached' && recording) {
      void stopRecording().then((saved) => setMessage(
        saved
          ? 'Recording stopped and saved because this session reached its 2-hour limit.'
          : 'Recording stopped because this session reached its 2-hour limit. Check the save status.',
        !saved
      ));
    }
  };
  inputChannelNode = connectFirstMicrophoneChannel(audioContext, sourceNode, analyserNode);
  analyserNode.connect(recorderNode);
  recorderNode.connect(silentGain).connect(audioContext.destination);
  const track = mediaStream.getAudioTracks()[0];
  if (!track) throw new Error('No active microphone input is available.');
  clearRecordingTrackMonitor();
  const trackMonitor = monitorRecordingTrack(track, {
    isRecording: () => recording,
    onMuted: () => {
      setStatus('Microphone input is paused. Waiting for it to resume…');
    },
    onUnmuted: () => {
      setStatus('Recording · Saving to this device', 'recording');
    },
    onEnded: () => {
      void stopRecording('Microphone input ended. Saved chunks are available for recovery.')
        .catch((error) => setMessage(`Unable to stop recording: ${error.message}`, true));
    },
    onMuteTimeout: () => {
      setStatus('Microphone input is paused · Recording continues');
      setMessage('Microphone input remains paused. Recording will continue until input resumes.', true);
    }
  });
  cleanupRecordingTrackMonitor = trackMonitor.cleanup;
  checkRecordingTrackMute = trackMonitor.checkCurrentMute;
  audioContext.addEventListener('statechange', () => {
    if (recording && audioContext?.state !== 'running' && activeTake) activeTake.timingDiscontinuous = true;
    if (recording && audioContext?.state === 'closed') {
      void stopRecording('AudioContext was closed. Saved chunks are available for recovery.')
        .catch((error) => setMessage(`Unable to stop recording: ${error.message}`, true));
    }
  });
  if (preparedAudioContextResume) {
    const resumeError = await preparedAudioContextResume;
    if (resumeError) throw resumeError;
  } else {
    await audioContext.resume();
  }
  if (audioContext.state !== 'running') {
    throw new Error(`The recording AudioContext did not start (state: ${audioContext.state}).`);
  }
  appendNetworkEvent(
    'Recording AudioContext ready',
    `state=${audioContext.state} currentTime=${audioContext.currentTime.toFixed(3)} s`
  );
  if (track.readyState !== 'live') throw new Error('Microphone input ended before recording started. Check the device and try again.');
  if (scheduledStartAt !== null && scheduledStartAt < performance.now() + 250) {
    throw new Error('The synchronized start could not be prepared in time. Check recording readiness and try again.');
  }
  if (cancelRecordingStart) {
    throw new Error('The synchronized recording start was canceled because the other participant could not prepare.');
  }
  preparedRecordingEvent = event;
  if (prepareOnly) {
    appendNetworkEvent(
      'Recording preparation complete',
      `event=${event?.eventId ?? 'local'}`
    );
    setStatus('Recording prepared · Waiting for both devices', 'ready');
    $('waveformState').textContent = 'Preparing';
    $('waveformState').classList.remove('live');
    return true;
  }
  await activatePreparedTake(event ? { startAt: scheduledStartAt, hostStartedAt: scheduledStartedAt, event } : null);
}

async function activatePreparedTake(schedule = null) {
  const plan = schedule === null ? null : createStartPlan(schedule, performance.now());
  const scheduledStartAt = plan?.localTargetPerfMs ?? null;
  const event = schedule?.event ?? null;
  if (!activeTake || !recorderNode || !audioContext) {
    throw new Error('Recording resources are not prepared on this device.');
  }
  if (preparedRecordingEvent &&
      (preparedRecordingEvent.eventId !== event?.eventId ||
       preparedRecordingEvent.sequence !== event?.sequence)) {
    throw new Error('The prepared recording event does not match the synchronized start.');
  }
  if (scheduledStartAt !== null && scheduledStartAt < performance.now() + 250) {
    throw new Error('The synchronized start could not be prepared in time. Check recording readiness and try again.');
  }
  if (cancelRecordingStart) {
    throw new Error('The synchronized recording start was canceled because the other participant could not prepare.');
  }
  if (plan) activeTake.startedAt = plan.displayStartedAt;
  activeTake.startPlan = plan;
  activeTake.startObservation = null;
  activeTake.timingPoints = [];
  activeTake.clockSamples = roomCall?.localRole === 'host' && roomCall.lastClockSample ? [roomCall.lastClockSample] : [];
  activeTake.timingDiscontinuous = false;
  activeTake.captureStatus = 'armed';
  activeTake.status = 'recording';
  await persistTake(activeTake);
  if (cancelRecordingStart) {
    await deleteUnstartedTake(activeTake.id);
    activeTake = null;
    preparedRecordingEvent = null;
    throw new Error('The synchronized recording start was canceled because the other participant could not prepare.');
  }
  if (scheduledStartAt !== null && scheduledStartAt < performance.now() + 250) {
    throw new Error('The synchronized start could not be prepared in time. Check recording readiness and try again.');
  }
  const startAt = scheduledStartAt === null
    ? null
    : audioContextTimeAtPerformanceTime(scheduledStartAt);
  recording = true;
  try {
    await new Promise((resolve, reject) => {
      const port = recorderNode.port;
      const previousHandler = port.onmessage;
      const timer = window.setTimeout(() => {
        port.onmessage = previousHandler;
        reject(new Error('The AudioWorklet did not confirm the recording start reservation.'));
      }, 1000);
      port.onmessage = (message) => {
        if (message.data.type === 'armed') {
          window.clearTimeout(timer);
          port.onmessage = previousHandler;
          appendNetworkEvent('Recording start armed', `event=${event?.eventId ?? 'local'}`);
          resolve();
        } else {
          previousHandler?.(message);
        }
      };
      port.postMessage({
        type: 'start',
        maximumFrames: takeFrameLimit,
        startAt,
        eventId: event?.eventId,
        sequence: event?.sequence
      });
    });
  } catch (error) {
    recording = false;
    throw error;
  }
  preparedRecordingEvent = null;
  checkRecordingTrackMute?.();
  if (!captureOnAir) takeStartedAt = scheduledStartAt ?? performance.now();
  elapsedTimer = window.setInterval(updateTimer, 200);
  recordButton.disabled = true;
  stopButton.disabled = false;
  const scheduled = scheduledStartAt !== null && !captureOnAir;
  setStatus(scheduled ? 'Recording scheduled · Saving to this device' : 'Recording · Saving to this device', scheduled ? 'ready' : 'recording');
  $('waveformState').textContent = scheduled ? 'Preparing' : 'LIVE';
  $('waveformState').classList.toggle('live', !scheduled);
  if (!scheduled) updateRecordingPreparation();
}

async function stopDiagnostics({ stopCapture = true } = {}) {
  clearRecordingTrackMonitor();
  checkRecordingTrackMute = null;
  if (sourceNode) sourceNode.disconnect();
  inputChannelNode?.disconnect();
  if (recorderNode) {
    recorderNode.port.onmessage = null;
    recorderNode.disconnect();
  }
  if (silentGain) silentGain.disconnect();
  if (stopCapture) mediaStream?.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== 'closed') await audioContext.close();
  sourceNode = null;
  inputChannelNode = null;
  analyserNode = null;
  recorderNode = null;
  silentGain = null;
  if (stopCapture) mediaStream = null;
  audioContext = null;
  waveformSamples = null;
}

async function stopRecording(recoveryReason = null) {
  if (preparedRecordingEvent && !recording) return discardPreparedTake();
  if (!activeTake || finalizing) return !recording && !finalizing;
  appendNetworkEvent(
    'Recording stop local',
    `requestedAt=${performance.now().toFixed(3)} ms frames=${activeTake.frames} recovery=${Boolean(recoveryReason)}`
  );
  finalizing = true;
  roomCall?.stopDriftMonitoring();
  recording = false;
  captureOnAir = false;
  captureStartPending = false;
  updateCaptureStatusBadge();
  stopWaveformRendering();
  updateRecordButtonAvailability();
  scheduledRecordingStartAt = null;
  scheduledRecordingWallStartAt = null;
  updateRecordingPreparation();
  roomCall?.endRecordingWaveform();
  roomCall?.setHostRecordingState(false);
  window.clearInterval(elapsedTimer);
  window.clearTimeout(takeRefreshTimer);
  takeRefreshTimer = null;
  recordButton.disabled = true;
  stopButton.disabled = true;
  setStatus(recoveryReason ? 'Recovering from saved chunks…' : 'Saving final chunk…');
  if (recorderNode) {
    recorderNode.port.postMessage({ type: 'stop' });
    await new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 3000);
      const existingHandler = recorderNode.port.onmessage;
      recorderNode.port.onmessage = (event) => {
        existingHandler?.(event);
        if (event.data.type === 'stopped') {
          window.clearTimeout(timeout);
          resolve();
        }
      };
    });
  }
  let failure = recoveryReason || commitError;
  try {
    await commitChain;
  } catch (error) {
    failure ||= `Unable to save to IndexedDB: ${error.message}`;
  }
  await stopDiagnostics({ stopCapture: false });
  if (mediaStream) startLocalPreview(mediaStream);
  const status = failure ? 'recovered' : 'stopped';
  activeTake = {
    ...activeTake,
    status,
    endedAt: Date.now(),
    tailUnknown: Boolean(failure),
    recoveryReason: failure ? String(failure) : null
  };
  try {
    const completedTake = activeTake;
    const transaction = database.transaction('takes', 'readwrite');
    const done = transactionComplete(transaction);
    const store = transaction.objectStore('takes');
    const request = store.get(completedTake.id);
    request.addEventListener('success', () => {
      if (!request.result) { transaction.abort(); return; }
      activeTake = { ...mergeRecordingMetadata(request.result, completedTake),
        status, endedAt: completedTake.endedAt, tailUnknown: completedTake.tailUnknown,
        recoveryReason: completedTake.recoveryReason };
      store.put(activeTake);
    }, { once: true });
    await done;
  } catch (error) {
    failure ||= `Unable to save the take completion status: ${error.message}`;
  }
  appendNetworkEvent(
    'Recording save local',
    `status=${failure ? 'recovered' : 'saved'} frames=${activeTake.frames} chunks=${activeTake.chunks}`
  );
  if (activeTake.transferGeneration) roomCall?.notifyTakeFinalized(activeTake);
  $('timer').textContent = formatDuration(activeTake.frames / TARGET_RATE);
  stopButton.disabled = true;
  finalizing = false;
  takeFrameLimit = 0;
  preparedRecordingEvent = null;
  setStatus(failure ? 'Recovery data saved. The unconfirmed final section is not included.' : 'Recording saved · Ready to export WAV', failure ? 'ready' : 'saved');
  $('waveformState').textContent = '';
  $('waveformState').classList.remove('live');
  if (failure) errorText.textContent = `${failure} Saved chunks can be exported as a recovered WAV from the list.`;
  activeTake = null;
  await renderTakes();
  const sessionFrames = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id && !take.remote)
    .reduce((total, take) => total + (take.frames || 0), 0);
  sessionLimitReached = sessionFrames >= MAX_SESSION_FRAMES;
  updateRecordButtonAvailability();
  if (sessionLimitReached) setStatus('This session has reached the 2-hour recording limit.');
  await updateSessionSavedSize();
  await refreshSessionList();
  if (!failure) setMessage('Recording data (WAV chunks) has been saved in the browser. Select “Save WAV” to save an audio file.');
  return !failure;
}

function audioContextTimeAtPerformanceTime(targetTime) {
  const timestamp = audioContext?.getOutputTimestamp?.();
  if (timestamp && Number.isFinite(timestamp.contextTime) && Number.isFinite(timestamp.performanceTime)) {
    const contextTarget = timestamp.contextTime + (targetTime - timestamp.performanceTime) / 1000;
    appendNetworkEvent(
      'Recording start schedule mapping',
      `targetPerf=${targetTime.toFixed(3)} ms nowPerf=${performance.now().toFixed(3)} ms context=${audioContext.state} currentTime=${audioContext.currentTime.toFixed(3)} s outputPerf=${timestamp.performanceTime.toFixed(3)} ms outputContext=${timestamp.contextTime.toFixed(3)} s targetContext=${contextTarget.toFixed(3)} s`
    );
    return contextTarget;
  }
  const contextTarget = audioContext.currentTime + (targetTime - performance.now()) / 1000;
  appendNetworkEvent(
    'Recording start schedule mapping',
    `targetPerf=${targetTime.toFixed(3)} ms nowPerf=${performance.now().toFixed(3)} ms context=${audioContext.state} currentTime=${audioContext.currentTime.toFixed(3)} s targetContext=${contextTarget.toFixed(3)} s`
  );
  return contextTarget;
}

function primeRecordingAudioContext() {
  if (primedRecordingAudioContext && primedRecordingAudioContext.state !== 'closed') {
    appendNetworkEvent(
      'Recording AudioContext',
      `reusing prepared context state=${primedRecordingAudioContext.state}`
    );
    return {
      context: primedRecordingAudioContext,
      resume: primedRecordingAudioContextResume
    };
  }
  const context = previewAudioContext?.state === 'running'
    ? previewAudioContext
    : new AudioContext({ sampleRate: TARGET_RATE });
  primedRecordingAudioContext = context;
  if (context === previewAudioContext) {
    primedRecordingAudioContextResume = Promise.resolve(null);
    appendNetworkEvent('Recording AudioContext', 'prepared running microphone preview context');
    return { context, resume: primedRecordingAudioContextResume };
  }

  const keepAlive = context.createOscillator();
  const silence = context.createGain();
  silence.gain.value = 0;
  keepAlive.connect(silence).connect(context.destination);
  keepAlive.start();
  primedRecordingAudioContextAnchor = { keepAlive, silence };
  appendNetworkEvent('Recording AudioContext', `created context state=${context.state}`);
  context.addEventListener('statechange', () => {
    appendNetworkEvent('Recording AudioContext state', context.state);
  });
  appendNetworkEvent('Recording AudioContext', 'resume requested');
  primedRecordingAudioContextResume = context.resume().then(() => {
    appendNetworkEvent('Recording AudioContext', 'resume completed');
    return null;
  }, (error) => {
    appendNetworkEvent('Recording AudioContext', `resume failed: ${error.message}`);
    return error;
  });
  return { context, resume: primedRecordingAudioContextResume };
}

function releasePrimedRecordingAudioContext() {
  const context = primedRecordingAudioContext;
  const anchor = primedRecordingAudioContextAnchor;
  primedRecordingAudioContext = null;
  primedRecordingAudioContextResume = null;
  primedRecordingAudioContextAnchor = null;
  if (!context || context === audioContext || context === previewAudioContext || context.state === 'closed') return;
  anchor?.keepAlive.stop();
  anchor?.keepAlive.disconnect();
  anchor?.silence.disconnect();
  void context.close();
}

async function startRecording(remoteSchedule = null, { prepareOnly = false, prepareEvent = null } = {}) {
  if (recording) return true;
  if (finalizing || starting || switchingMicrophone || !activeSession) return false;
  if (roomCall?.isActive && !roomCall.isGuest && !roomCall.canStartRecording) {
    errorText.textContent = 'Connect the call and confirm both participants are ready before starting to record.';
    return false;
  }
  if (switchingMicrophone) return false;
  starting = true;
  captureOnAir = false;
  captureStartPending = true;
  updateCaptureStatusBadge();
  cancelRecordingStart = false;
  updateRecordButtonAvailability();
  scheduledRecordingStartAt = remoteSchedule?.startAt ?? null;
  scheduledRecordingWallStartAt = remoteSchedule?.hostStartedAt ?? null;
  updateRecordingPreparation();
  recordButton.disabled = true;
  let preparedAudioContext = null;
  let synchronizedStartAnnounced = false;
  let preparationAnnounced = false;
  let preparationEvent = null;
  try {
    const prepared = preparedRecordingEvent
      ? { context: audioContext, resume: Promise.resolve(null) }
      : primeRecordingAudioContext();
    preparedAudioContext = prepared.context;
    if (!roomCall?.isGuest) {
      try {
        if (!await getHostSession()) {
          const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          window.location.replace(`/index.html?returnTo=${encodeURIComponent(returnTo)}`);
          return false;
        }
      } catch (error) {
        errorText.textContent = `Unable to verify host authentication: ${error.message}`;
        return false;
      }
    }
    if (prepareOnly) {
      await createTake({
        prepareOnly: true,
        event: prepareEvent,
        preparedAudioContext: prepared.context,
        preparedAudioContextResume: prepared.resume
      });
      preparedAudioContext = null;
      return preparedRecordingEvent !== null;
    }
    let schedule = remoteSchedule;
    if (roomCall?.isPeerReadyForRecording && !roomCall.isGuest && !schedule) {
      const clockOffsetMs = await roomCall.synchronizeClock();
      const event = { eventId: crypto.randomUUID(), sequence: roomCall.recordingSequence + 1 };
      preparationEvent = event;
      preparationAnnounced = true;
      const localPreparation = createTake({
        prepareOnly: true,
        event,
        preparedAudioContext: prepared.context,
        preparedAudioContextResume: prepared.resume
      });
      preparedAudioContext = null;
      const guestPreparation = roomCall.prepareGuestRecording(event.eventId, event.sequence);
      try {
        await Promise.all([localPreparation, guestPreparation]);
      } catch (error) {
        roomCall.cancelGuestRecordingPreparation(event.eventId);
        await localPreparation.catch(() => {});
        throw error;
      }
      if (cancelRecordingStart) {
        throw new Error('The synchronized recording start was canceled because the other participant could not prepare.');
      }
      const startLeadMs = Math.max(
        SYNCHRONIZED_START_LEAD_MS,
        (roomCall.clockRoundTripMs ?? 0) + SYNCHRONIZED_START_LEAD_MS
      );
      const startAt = performance.now() + startLeadMs;
      schedule = {
        startAt,
        hostStartedAt: Date.now() + (startAt - performance.now()),
        clockOffsetMs,
        event
      };
      scheduledRecordingStartAt = schedule.startAt;
      scheduledRecordingWallStartAt = schedule.hostStartedAt;
      updateRecordingPreparation();
    }
    if (schedule && roomCall?.localRole === 'host') {
      const command = roomCall.setHostRecordingState(
        true,
        schedule.startAt,
        schedule.clockOffsetMs,
        schedule.event.eventId,
        schedule.hostStartedAt
      );
      if (!command) throw new Error('Unable to send the synchronized recording start to the guest.');
      synchronizedStartAnnounced = true;
    }
    if (schedule && preparedRecordingEvent) {
      await activatePreparedTake(schedule);
      return recording;
    }
    if (schedule && roomCall?.localRole === 'guest') {
      throw new Error('The synchronized start arrived before recording preparation completed.');
    }
    await createTake({
      scheduledStartAt: schedule?.startAt ?? null,
      scheduledStartedAt: schedule?.hostStartedAt ?? null,
      event: schedule?.event ?? null,
      preparedAudioContext: prepared.context,
      preparedAudioContextResume: prepared.resume
    });
    preparedAudioContext = null;
    return recording;
  } catch (error) {
    const unstartedPreparedTake = Boolean(preparedRecordingEvent && !recording);
    await stopDiagnostics({ stopCapture: false });
    if (preparationEvent) roomCall?.cancelGuestRecordingPreparation(preparationEvent.eventId);
    if ((synchronizedStartAnnounced || preparationAnnounced) && !cancelRecordingStart) {
      roomCall.setHostRecordingState(false);
    }
    if (activeTake && ['preparing', 'recording'].includes(activeTake.status)) {
      if ((cancelRecordingStart || unstartedPreparedTake || prepareOnly || preparationAnnounced) && !recording) {
        const cancelledTake = activeTake;
        activeTake = null;
        preparedRecordingEvent = null;
        try {
          await deleteUnstartedTake(cancelledTake.id);
        } catch (deleteError) {
          activeTake = {
            ...cancelledTake,
            status: 'recovered',
            endedAt: Date.now(),
            tailUnknown: true,
            recoveryReason: error.message
          };
          await persistTake(activeTake).catch((saveError) => {
            errorText.textContent = `${error.message} Unable to save canceled take recovery data: ${saveError.message}`;
          });
          activeTake = null;
          errorText.textContent ||= `Unable to discard canceled take: ${deleteError.message}`;
          await renderTakes();
        }
        preparedRecordingEvent = null;
      } else {
        activeTake = { ...activeTake, status: 'recovered', endedAt: Date.now(), tailUnknown: true, recoveryReason: error.message };
        await persistTake(activeTake).catch((saveError) => { errorText.textContent = `${error.message} Unable to save take status: ${saveError.message}`; });
        activeTake = null;
        await renderTakes();
      }
    }
    const errorDetails = [error.name, error.constraint || error.constraintName, error.message]
      .filter(Boolean)
      .join(' · ') || String(error);
    errorText.textContent ||= error.name === 'NotAllowedError'
      ? 'Microphone access was denied. Check your browser site settings.'
      : error.name === 'OverconstrainedError' && (error.constraint || error.constraintName) === 'deviceId'
        ? 'The selected microphone was not found or is unavailable. Select “Detect Devices” to refresh the list and choose another input.'
        : `Unable to start recording: ${errorDetails}`;
    captureOnAir = false;
    captureStartPending = false;
    setStatus('Unable to start recording');
    recordButton.disabled = false;
    stopButton.disabled = true;
    scheduledRecordingStartAt = null;
    scheduledRecordingWallStartAt = null;
    return false;
  } finally {
    if (preparedAudioContext && preparedAudioContext !== audioContext &&
        preparedAudioContext.state !== 'closed') {
      await preparedAudioContext.close();
    }
    starting = false;
    cancelRecordingStart = false;
    if (!recording && !captureOnAir && !preparedRecordingEvent) captureStartPending = false;
    updateCaptureStatusBadge();
    updateRecordingPreparation();
    updateRecordButtonAvailability();
    if (!recording && !preparedRecordingEvent && activeSession && !studioView.hidden && mediaStream) {
      startLocalPreview(mediaStream);
    }
  }
}

async function discardPreparedTake() {
  if (!preparedRecordingEvent || recording) return false;
  const take = activeTake;
  await stopDiagnostics({ stopCapture: false });
  activeTake = null;
  preparedRecordingEvent = null;
  captureOnAir = false;
  captureStartPending = false;
  scheduledRecordingStartAt = null;
  scheduledRecordingWallStartAt = null;
  if (take) await deleteUnstartedTake(take.id);
  updateCaptureStatusBadge();
  updateRecordingPreparation();
  updateRecordButtonAvailability();
  if (activeSession && !studioView.hidden && mediaStream) startLocalPreview(mediaStream);
  return true;
}

function applyHostRecordingState(isRecording, schedule = null) {
  if (!isRecording && starting && !recording) cancelRecordingStart = true;
  const previousState = lastHostRecordingState;
  lastHostRecordingState = isRecording;
  hostRecordingCommand = hostRecordingCommand.then(async () => {
    if (isRecording) {
      $('hostRecordingStatus').textContent = 'Starting recording in sync with the host…';
      const started = recording || await startRecording(schedule);
      $('hostRecordingStatus').textContent = recording
        ? scheduledRecordingStartAt !== null
          ? 'Waiting for the host to start recording. Wait until the recording indicator changes.'
          : 'Recording in sync with the host'
        : 'Unable to start recording on this device. Check the error below.';
      return started;
    }
    if (recording) {
      $('hostRecordingStatus').textContent = 'Saving in sync with the host’s stop…';
      const stopped = await stopRecording();
      $('hostRecordingStatus').textContent = stopped
        ? 'Stopped in sync with the host and saved on this device'
        : 'Unable to confirm the stop or save. Check the error.';
      return stopped;
    }
    if (preparedRecordingEvent) {
      const discarded = await discardPreparedTake();
      $('hostRecordingStatus').textContent = discarded
        ? 'Recording preparation was canceled by the host'
        : 'Waiting for the host to record';
      return discarded;
    }
    $('hostRecordingStatus').textContent = previousState
      ? 'Stopped in sync with the host and saved on this device'
      : 'Waiting for the host to record';
    return true;
  }).catch((error) => {
    errorText.textContent = `Unable to apply the host recording status: ${error.message}`;
    $('hostRecordingStatus').textContent = 'Unable to apply recording status. Check the error.';
    return false;
  });
  return hostRecordingCommand;
}

async function getTakeChunks(takeId) {
  const transaction = database.transaction('chunks', 'readonly');
  const done = transactionComplete(transaction);
  const index = transaction.objectStore('chunks').index('takeId');
  const chunks = await requestResult(index.getAll(IDBKeyRange.only(takeId)));
  await done;
  return chunks.sort((left, right) => left.sequence - right.sequence);
}

async function exportTake(take, exportButton, alignment = null) {
  const outputFrames = alignment?.outputFrames ?? take.frames;
  const totalBytes = 44 + outputFrames * BYTES_PER_FRAME;
  const filename = alignment
    ? makeRecordingFilename(activeSession, take).replace(/\.wav$/u, '_aligned.wav')
    : makeRecordingFilename(activeSession, take);
  const writeOutput = (chunks, writable) => alignment
    ? writeAlignedPcm24Wav(take, chunks, writable, alignment)
    : writePcm24Wav(take, chunks, writable);
  if (!Number.isSafeInteger(take.frames) || take.frames <= 0 || totalBytes > MAX_WAV_BYTES) {
    setMessage('Export WAV files no larger than 1 GiB.', true);
    return;
  }
  exportButton.disabled = true;
  try {
    const fileHandle = typeof window.showSaveFilePicker === 'function'
      ? await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }]
        })
      : null;
    const chunks = await getTakeChunks(take.id);
    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      try {
        await writeOutput(chunks, writable);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort(error);
        } catch (abortError) {
          throw new AggregateError([error, abortError], 'Both writing the WAV and aborting the write failed.');
        }
        throw error;
      }
      setMessage('PCM24 WAV exported to the selected destination.');
      return;
    }
    if (totalBytes > BLOB_DOWNLOAD_LIMIT) {
      setMessage('This browser cannot safely save WAV files larger than 256 MB. Use a supported version of Chrome or Edge and select a destination.', true);
      return;
    }
    const blobParts = [];
    await writeOutput(chunks, {
      async write(data) {
        blobParts.push(data);
      }
    });
    const output = new Blob(blobParts, { type: 'audio/wav' });
    const url = URL.createObjectURL(output);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = filename;
    downloadLink.className = 'take-action';
    downloadLink.textContent = 'Download';
    exportButton.replaceWith(downloadLink);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setMessage('WAV is ready. Select “Download” in the recording list to save it.');
  } catch (error) {
    if (error.name === 'AbortError') {
      setMessage('WAV save canceled.');
      return;
    }
    setMessage(`Unable to export WAV: ${error.message}`, true);
  } finally {
    if (exportButton.isConnected) exportButton.disabled = false;
  }
}

async function recoverInterruptedTakes() {
  const takes = await loadAll('takes');
  const preparing = takes.filter((take) => take.status === 'preparing');
  for (const take of preparing) await deleteUnstartedTake(take.id);
  const interrupted = takes.filter((take) => take.status === 'recording');
  for (const take of interrupted) {
    await persistTake({
      ...take,
      status: 'recovered',
      endedAt: Date.now(),
      tailUnknown: true,
      recoveryReason: 'The tab or browser closed before recording ended. Recovery includes only confirmed chunks.'
    });
  }
  if (interrupted.length) setMessage(`Loaded ${interrupted.length} interrupted take(s) for recovery.`);
}

async function stopDiagnosticsOnUnload() {
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
}

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const participant = participantNameInput.value.trim();
  if (!participant || !micDevice.value) {
    $('statusMessage').textContent = 'Enter your name and select a recording microphone.';
    return;
  }
  const createdAt = Date.now();
  const sessionName = new Date(createdAt).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const session = {
    id: crypto.randomUUID(),
    name: `Recording ${sessionName}`,
    participant,
    createdAt,
    guestSession: roomCall?.isGuest === true
  };
  try {
    await persistSession(session);
    activeSession = session;
    await openSession(session);
  } catch (error) {
    $('statusMessage').textContent = `Unable to save the session: ${error.message}`;
  }
});

participantNameInput.addEventListener('beforeinput', () => {
  participantNameEdited = true;
});
$('detectDevices').addEventListener('click', () => { void detectDevices(); });
studioTitleInput.addEventListener('input', () => { void saveStudioSessionName(); });
studioTitleInput.addEventListener('blur', () => {
  if (activeSession) studioTitleInput.value = activeSession.name;
});
$('deleteSessionButton').addEventListener('click', () => { void deleteActiveSession(); });
$('deleteSelectedSessionsButton').addEventListener('click', () => { void deleteSelectedSessions(); });
micDevice.addEventListener('change', () => { trackMicDevice.value = micDevice.value; updateRecordButtonAvailability(); });
trackMicDevice.addEventListener('change', () => { void changeMicrophone(); });
$('microphoneMuteButton').addEventListener('click', toggleMicrophoneMute);
navigator.mediaDevices?.addEventListener('devicechange', () => { if (!switchingMicrophone) void detectDevices(false); });
recordButton.addEventListener('click', () => {
  if (!roomCall?.isGuest) void startRecording();
});
stopButton.addEventListener('click', () => {
  if (!roomCall?.isGuest) void stopRecording();
});
$('backButton').addEventListener('click', async () => {
  if (recording || finalizing) {
    setMessage('Stop and save the recording before returning to the session list.', true);
    return;
  }
  if (roomCall?.isActive) {
    setMessage('End the call or invitation before returning to the session list.', true);
    return;
  }
  if (switchingMicrophone) {
    setMessage('Wait for the microphone switch to complete before returning to the session list.', true);
    return;
  }
  if (!await saveStudioSessionName()) return;
  stopLocalPreview();
  await releaseCaptureStream();
  activeSession = null;
  updateRecordButtonAvailability();
  stopWaveformRendering();
  studioView.hidden = true;
  setupView.hidden = false;
  await refreshSessionList();
  await updateSessionSavedSize();
});
window.addEventListener('beforeunload', () => {
  if (transferProgressTimer !== null) window.clearInterval(transferProgressTimer);
  void stopDiagnosticsOnUnload();
});

async function initialize() {
  const invitation = new URLSearchParams(window.location.hash.slice(1));
  const guestInvitation = invitation.has('session') && invitation.has('invite') && invitation.has('host');
  if (!guestInvitation) {
    let authSession;
    try {
      authSession = await getHostSession();
    } catch (error) {
      $('statusMessage').textContent = `Unable to verify host authentication: ${error.message}`;
      setupForm.querySelector('button[type="submit"]').disabled = true;
      return;
    }
    if (!authSession) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/index.html?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    void getHostDisplayName(authSession).then((name) => {
      if (name && !participantNameEdited && !activeSession) participantNameInput.value = name;
    });
    $('logoutButton').hidden = false;
    $('logoutButton').addEventListener('click', async () => {
      if (recording || finalizing) {
        $('statusMessage').textContent = 'Stop and save the recording before logging out.';
        return;
      }
      if (roomCall?.isActive) {
        $('statusMessage').textContent = 'End the call or invitation before logging out.';
        return;
      }
      $('logoutButton').disabled = true;
      try {
        await signOut(await getAuth0Client());
      } catch (error) {
        $('statusMessage').textContent = `Unable to log out: ${error.message}`;
        $('logoutButton').disabled = false;
      }
    });
  }
  try {
    database = await openDatabase();
    database.addEventListener('versionchange', () => database.close());
    roomCall = new RoomCall({
      getSession: () => activeSession,
      getParticipantName: () => participantNameInput.value,
      getMicrophoneStream: ensureCaptureStream,
      releaseMicrophone: releaseCaptureStream,
      getRecordingState: () => recording,
      checkReadiness: checkRecordingReadiness,
      onReadinessState: () => updateRecordButtonAvailability(),
      onRecordingPrepare: ({ eventId, sequence }) => startRecording(null, {
        prepareOnly: true,
        prepareEvent: { eventId, sequence }
      }),
      onRecordingState: applyHostRecordingState,
      onClockMeasurement: (sample) => {
        if (!recording || finalizing || !activeTake || !sample) return;
        const samples = activeTake.clockSamples ?? [];
        if (samples.length < MAX_TIMING_POINTS && (!samples.length || sample.hostPerfMs > samples.at(-1).hostPerfMs)) {
          activeTake.clockSamples = [...samples, sample];
          queueRecordingMetadata({ clockSamples: activeTake.clockSamples });
        }
      },
      onSynchronization: async (result) => {
        try {
          const transaction = database.transaction('takes', 'readwrite');
          const done = transactionComplete(transaction);
          const cursorRequest = transaction.objectStore('takes').openCursor();
          cursorRequest.addEventListener('success', () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const take = cursor.value;
            if (take.startPlan?.eventId === result.eventId && take.startPlan.sequence === result.sequence) {
              cursor.update({ ...take, synchronization: result });
            }
            cursor.continue();
          });
          await done;
          if (activeTake?.startPlan?.eventId === result.eventId) activeTake.synchronization = result;
          scheduleTakeRefresh();
        } catch (error) {
          appendNetworkEvent('Synchronization result save failed', error.message);
        }
      },
      onNetworkEvent: appendNetworkEvent,
      prepareRecordingAudioContext: () => { primeRecordingAudioContext(); },
      releasePreparedRecordingAudioContext: releasePrimedRecordingAudioContext,
      onSessionName: async (name) => {
        if (roomCall?.isGuest !== true || !activeSession) return;
        activeSession.name = name;
        $('guestStudioTitle').textContent = name;
        try {
          await persistSession({ ...activeSession });
          await refreshSessionList();
        } catch (error) {
          errorText.textContent = `Unable to save the session name received from the host: ${error.message}`;
        }
      },
      getNextTransferChunk,
      prepareTransferChunk,
      markTransferChunkStored: markTransferChunkStored,
      getNextTransferManifest,
      hasPendingTransfer,
      markTransferManifestStored,
      getTransferInventory,
      reconcileTransferInventory: reconcileGuestTransferInventory,
      storeIncomingTransferChunk,
      storeIncomingTransferManifest,
      onLocalStream: (stream) => {
        if (stream) {
          startLocalPreview(stream);
        } else {
          stopLocalPreview();
          if (!recording) setLocalWaveformState('Waiting');
        }
      },
      onError: (error) => { errorText.textContent = error.message; }
    });
    await recoverInterruptedTakes();
    await refreshSessionList();
    await updateSessionSavedSize();
    transferProgressTimer = window.setInterval(() => {
      void updateTransferProgress().catch((error) => {
        const card = $('transferProgressCard');
        card.classList.add('transfer-error');
        $('networkProgressError').textContent = error.message;
        $('networkProgressErrorRow').hidden = false;
      });
    }, 1000);
  } catch (error) {
    $('statusMessage').textContent = `Unable to initialize local storage: ${error.message}`;
    setupForm.querySelector('button[type="submit"]').disabled = true;
  }
}

void initialize();
void detectDevices(false);
