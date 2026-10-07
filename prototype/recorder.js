import { RoomCall } from './room-call.js';
import { MAX_SESSION_FRAMES, remainingSessionFrames } from './recording-limits.js';
import { RecordingTransfer, takeWithTransferParticipant } from './recording-transfer.js';
import { canQueueRecordingCommit } from './recording-commit-queue.js';
import { verifyIncomingStoredChunk, verifyIncomingStoredTake } from './recording-storage.js';
import { reconcileTransferInventory } from './transfer-inventory.js';
import { createPcm24Wav, writePcm24Wav } from './wav-export.js';
import { splitTransferBacklog, summarizeTransferChunks } from './transfer-progress.js';
import { monitorRecordingTrack } from './recording-track-monitor.js';
import { makeRecordingFilename } from './recording-filename.js';

const TARGET_RATE = 48000;
const BYTES_PER_FRAME = 3;
const CHUNK_FRAMES = TARGET_RATE;
const DB_NAME = 'perfectpodcast-local-v1';
const DB_VERSION = 3;
const BLOB_DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const MAX_WAV_BYTES = 1024 * 1024 * 1024;
const RAW_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
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
const sessionList = $('sessionList');
const takeList = $('takeList');
const recordButton = $('recordButton');
const stopButton = $('stopButton');
const recordingPreparation = $('recordingPreparation');
const errorText = $('errorText');
const notice = $('notice');
const meter = document.querySelector('[role="meter"]');
const waveformCanvas = $('waveformCanvas');

let database;
let activeSession = null;
let roomCall = null;
let activeTake = null;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let analyserNode = null;
let recorderNode = null;
let silentGain = null;
let previewAudioContext = null;
let previewSourceNode = null;
let previewAnalyserNode = null;
let previewSilentGain = null;
let previewSamples = null;
let previewStream = null;
let previewStartedAt = 0;
let recording = false;
let finalizing = false;
let starting = false;
let sessionLimitReached = false;
let pendingCommits = 0;
let commitChain = Promise.resolve();
let commitError = null;
let nextSequence = 0;
let capturedFrames = 0;
let takeFrameLimit = 0;
let elapsedTimer = null;
let preparationTimer = null;
let scheduledRecordingStartAt = null;
let takeRefreshTimer = null;
let noticeTimer = null;
let takeStartedAt = 0;
let lastPeak = 0;
let waveformSamples = null;
let waveformFrame = null;
let waveformHistory = new Float32Array(600);
let waveformCount = 0;
let lastWaveformSample = 0;
let lastRulerSecond = -1;
let waveformElapsedSeconds = 0;
let hostRecordingCommand = Promise.resolve();
let lastHostRecordingState = null;
const receivedTransferFrames = new Map();
let previousTransferProgress = null;
let transferProgressTimer = null;
let transferProgressCache = null;
let transferGraphSamples = [];
let cleanupRecordingTrackMonitor = null;

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
      reject(new Error('このブラウザーでは IndexedDB を利用できません。Chrome または Edge を使用してください。'));
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
    request.addEventListener('error', () => reject(request.error || new Error('ローカル録音データベースを開けませんでした。')), { once: true });
    request.addEventListener('blocked', () => reject(new Error('別タブがデータベース更新を妨げています。録音タブを閉じて再読み込みしてください。')), { once: true });
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

function setStatus(text, kind = 'ready') {
  $('statusText').textContent = text;
  $('statusDot').className = `status-dot${kind === 'recording' ? ' live' : kind === 'saved' ? ' saved' : ''}`;
}

function updateRecordingPreparation() {
  let message = '';
  if (scheduledRecordingStartAt !== null) {
    const seconds = Math.ceil((scheduledRecordingStartAt - performance.now()) / 1000);
    message = seconds > 0
      ? `録音開始まであと ${seconds} 秒です。録音中の表示に切り替わるまで話し始めずにお待ちください。`
      : '録音開始を確認しています。録音中の表示に切り替わるまでお待ちください。';
  } else if (starting) {
    message = '録音準備中です。開始時刻と録音環境を確認しています。録音中の表示に切り替わるまで話し始めずにお待ちください。';
  }
  if (!message) {
    recordingPreparation.hidden = true;
    window.clearInterval(preparationTimer);
    preparationTimer = null;
    if (recording && !finalizing) setStatus('録音中 · 端末へ順次保存しています', 'recording');
    return;
  }
  recordingPreparation.hidden = false;
  recordingPreparation.textContent = message;
  if ($('statusText').textContent !== message) setStatus(message);
  if (preparationTimer === null) {
    preparationTimer = window.setInterval(updateRecordingPreparation, 200);
  }
}

function updateRecordButtonAvailability() {
  recordButton.disabled = sessionLimitReached || recording || starting || finalizing ||
    Boolean(roomCall?.isActive && !roomCall.isGuest && !roomCall.canStartRecording);
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
        ? 'このセッションの2時間上限に達したため、録音を停止して保存しました。'
        : 'このセッションの2時間上限に達したため録音を停止しました。保存状態を確認してください。',
      !saved
    ));
  }
}

function updateMeter(peak) {
  lastPeak = Math.max(lastPeak * 0.82, peak);
  const db = lastPeak > 0.0001 ? 20 * Math.log10(lastPeak) : -Infinity;
  const percent = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
  const fill = $('meterFill');
  fill.style.width = `${percent}%`;
  fill.className = `meter-fill${lastPeak >= 0.999 ? ' clipping' : db >= -6 ? ' near-clip' : db >= -40 ? ' good' : ''}`;
  meter.setAttribute('aria-valuenow', String(Math.round(percent)));
  $('meterHint').textContent = lastPeak >= 0.999 ? '入力が大きすぎます' : db >= -40 ? '入力を検出中' : '小さな音を待っています';
}

function setLocalWaveformState(text, live = false) {
  $('waveformState').textContent = text;
  $('waveformState').classList.toggle('live', live);
}

function startLocalPreview(stream) {
  if (!stream || recording || starting || previewStream === stream) return;
  stopLocalPreview();
  if (!window.AudioContext) {
    setLocalWaveformState('波形非対応');
    return;
  }
  try {
    previewStream = stream;
    previewAudioContext = new AudioContext();
    previewSourceNode = previewAudioContext.createMediaStreamSource(stream);
    previewAnalyserNode = previewAudioContext.createAnalyser();
    previewAnalyserNode.fftSize = 2048;
    previewSamples = new Float32Array(previewAnalyserNode.fftSize);
    previewSilentGain = previewAudioContext.createGain();
    previewSilentGain.gain.value = 0;
    previewSourceNode.connect(previewAnalyserNode);
    previewAnalyserNode.connect(previewSilentGain).connect(previewAudioContext.destination);
    previewStartedAt = performance.now();
    waveformHistory.fill(0);
    waveformCount = 0;
    lastWaveformSample = 0;
    const context = previewAudioContext;
    if (context.state === 'running') {
      setLocalWaveformState('LIVE', true);
    } else if (context.state === 'suspended') {
      setLocalWaveformState('波形準備中');
      void context.resume().then(() => {
        if (previewAudioContext === context && !recording) setLocalWaveformState('LIVE', true);
      }).catch((error) => {
        if (previewAudioContext !== context) return;
        setLocalWaveformState('波形停止');
        setMessage(`自分の波形を開始できませんでした: ${error.message}`, true);
      });
    } else {
      setLocalWaveformState('波形停止');
    }
  } catch (error) {
    stopLocalPreview();
    setLocalWaveformState('波形エラー');
    setMessage(`自分の波形を開始できませんでした: ${error.message}`, true);
  }
}

function stopLocalPreview() {
  previewSourceNode?.disconnect();
  previewAnalyserNode?.disconnect();
  previewSilentGain?.disconnect();
  if (previewAudioContext && previewAudioContext.state !== 'closed') {
    void previewAudioContext.close();
  }
  previewAudioContext = null;
  previewSourceNode = null;
  previewAnalyserNode = null;
  previewSilentGain = null;
  previewSamples = null;
  previewStream = null;
}

function drawWaveform() {
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
  if (recording) waveformElapsedSeconds = (now - takeStartedAt) / 1000;
  else if (previewStream && previewAudioContext?.state === 'running') {
    waveformElapsedSeconds = (now - previewStartedAt) / 1000;
  }
  const elapsedSeconds = waveformElapsedSeconds;
  const currentAnalyser = recording ? analyserNode : previewAnalyserNode;
  const currentSamples = recording ? waveformSamples : previewSamples;
  const canSample = recording || Boolean(previewStream && previewAudioContext?.state === 'running');
  if (currentAnalyser && currentSamples && canSample && now - lastWaveformSample >= 100) {
    currentAnalyser.getFloatTimeDomainData(currentSamples);
    let peak = 0;
    for (const sample of currentSamples) peak = Math.max(peak, Math.abs(sample));
    if (waveformCount === waveformHistory.length) {
      waveformHistory.copyWithin(0, 1);
      waveformHistory[waveformHistory.length - 1] = peak;
    } else {
      waveformHistory[waveformCount] = peak;
      waveformCount += 1;
    }
    lastWaveformSample = now;
    setLocalWaveformState('LIVE', true);
  }
  if (waveformCount > 0) {
    context.beginPath();
    context.lineWidth = Math.max(1, pixelRatio);
    context.strokeStyle = '#55d6b2';
    context.shadowColor = 'rgb(85 214 178 / 45%)';
    context.shadowBlur = 5 * pixelRatio;
    for (let index = 0; index < waveformCount; index += 1) {
      const x = (index / waveformHistory.length) * width;
      const amplitude = Math.sqrt(Math.max(0, waveformHistory[index])) * height * 0.44;
      context.moveTo(x, height / 2 - amplitude);
      context.lineTo(x, height / 2 + amplitude);
    }
    context.stroke();
    context.shadowBlur = 0;
  }
  const rulerSecond = Math.floor(elapsedSeconds);
  if (rulerSecond !== lastRulerSecond) {
    const firstMark = elapsedSeconds >= 60 ? elapsedSeconds - 60 : 0;
    for (let index = 0; index < 5; index += 1) {
      $('waveMark' + index).textContent = formatDuration(firstMark + index * 15);
    }
    lastRulerSecond = rulerSecond;
  }
  waveformFrame = window.requestAnimationFrame(drawWaveform);
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

async function persistTake(take) {
  const transaction = database.transaction('takes', 'readwrite');
  const done = transactionComplete(transaction);
  transaction.objectStore('takes').put(take);
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
  const transaction = database.transaction('chunks', 'readwrite');
  const done = transactionComplete(transaction);
  const store = transaction.objectStore('chunks');
  const request = store.get([takeId, sequence]);
  let newlyStoredChunk = null;
  request.addEventListener('success', () => {
    const chunk = request.result;
    if (!chunk) {
      transaction.abort();
      return;
    }
    if (chunk.sha256 && chunk.sha256 !== sha256) {
      transaction.abort();
      return;
    }
    if (!chunk.hostStored) newlyStoredChunk = chunk;
    store.put({ ...chunk, hostStored: true, sha256 });
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
  if (!generation) throw new Error('転送inventoryの接続世代がありません。');
  transferProgressCache = null;
  const range = IDBKeyRange.only(generation);
  if (roomCall?.localRole === 'guest') {
    const chunks = await findIndexValues('chunks', 'transferGeneration', range, (chunk) =>
      chunk.transferGeneration === generation && !chunk.remote && Boolean(chunk.sha256),
    (chunk) => ({ kind: 'chunk', takeId: chunk.takeId, sequence: chunk.sequence, sha256: chunk.sha256 }));
    const takes = await findIndexValues('takes', 'transferGeneration', IDBKeyRange.only(generation), (take) =>
      !take.remote && take.status !== 'recording' && take.frames > 0 && take.chunks > 0,
    (take) => ({ kind: 'manifest', takeId: take.id }));
    return [...chunks, ...takes];
  }
  if (roomCall?.localRole !== 'host') throw new Error('この端末は転送inventoryのホストではありません。');
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
        roomCall.setStatus(`IndexedDB内の受信音源を検証できず、該当takeを再回収します: ${error.message}`, true);
        continue;
      }
    } else {
      for (const chunk of chunks) {
        if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 ||
            !Number.isSafeInteger(chunk.startFrame) || chunk.startFrame < 0 ||
            !Number.isSafeInteger(chunk.frames) || chunk.frames < 1 ||
            !/^[0-9a-f]{64}$/u.test(chunk.sha256 || '') || chunk.sourceTakeId !== take.sourceTakeId) {
          roomCall.setStatus('ホストの部分take台帳に不正な行があり、該当チャンクを再回収します。', true);
          continue;
        }
        try {
          const storedChunk = savedChunksBySequence.get(chunk.sequence);
          await verifyIncomingStoredChunk(take, storedChunk, chunk.sequence, chunk.startFrame);
          if (storedChunk.sha256 !== chunk.sha256 || storedChunk.frames !== chunk.frames) {
            throw new Error('チャンク台帳とWAVの内容が一致しません。');
          }
        } catch (error) {
          roomCall.setStatus(`IndexedDB内のチャンクを再検証できず、再回収します: ${error.message}`, true);
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
      bytes: chunk.byteLength ?? chunk.wav?.size,
      frames: chunk.frames,
      hostStored: chunk.hostStored === true
    })
  );
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

function drawTransferGraph(now) {
  const canvas = $('transferGraph');
  const context = canvas.getContext?.('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const left = 38;
  const right = width - 8;
  const top = 8;
  const bottom = height - 20;
  const maxMbps = Math.max(1.5, ...transferGraphSamples.flatMap((sample) =>
    [sample.sendMbps, sample.ackMbps].filter(Number.isFinite)));
  const y = (value) => bottom - Math.min(maxMbps, value) / maxMbps * (bottom - top);
  context.clearRect(0, 0, width, height);
  context.font = '10px sans-serif';
  context.fillStyle = '#aeb8c2';
  context.strokeStyle = '#303a44';
  context.lineWidth = 1;
  context.setLineDash([]);
  for (const value of [0, maxMbps / 2, maxMbps]) {
    const lineY = y(value);
    context.beginPath();
    context.moveTo(left, lineY);
    context.lineTo(right, lineY);
    context.stroke();
    context.fillText(value.toFixed(1), 2, lineY + 3);
  }
  context.fillText('60秒前', left, height - 4);
  context.fillText('現在', right - 25, height - 4);

  context.strokeStyle = '#e9b85b';
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(left, y(1.152));
  context.lineTo(right, y(1.152));
  context.stroke();
  context.setLineDash([]);

  for (const [key, color] of [['sendMbps', '#59d6b2'], ['ackMbps', '#82aaff']]) {
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
      const pointY = y(sample[key]);
      if (started) context.lineTo(x, pointY);
      else context.moveTo(x, pointY);
      started = true;
    }
    context.stroke();
  }
}

function updateTransferGraph(now, sendMbps, ackBytesPerSecond) {
  const ackMbps = Number.isFinite(ackBytesPerSecond)
    ? ackBytesPerSecond * 8 / 1_000_000
    : null;
  transferGraphSamples.push({
    at: now,
    sendMbps: Number.isFinite(sendMbps) ? sendMbps : null,
    ackMbps
  });
  transferGraphSamples = transferGraphSamples.filter((sample) => now - sample.at <= 60_000).slice(-61);
  drawTransferGraph(now);
  const sample = transferGraphSamples.at(-1);
  const sendText = sample.sendMbps === null ? '—' : `${sample.sendMbps.toFixed(2)} Mbps`;
  const ackText = sample.ackMbps === null ? '—' : `${sample.ackMbps.toFixed(2)} Mbps`;
  $('transferGraphSummary').textContent =
    `直近60秒: DataChannel送出 ${sendText} · ACK確定 ${ackText} · マスター生成基準 1.152 Mbps`;
}

async function updateTransferProgress() {
  const card = $('transferProgressCard');
  const text = $('transferProgressText');
  const details = $('transferProgressDetails');
  const diagnostics = $('transferDiagnostics');
  const bar = $('transferProgressBar');
  const generation = roomCall?.authFields?.generation;
  if (!roomCall?.localRole || !generation) {
    card.hidden = true;
    card.classList.remove('transfer-error');
    diagnostics.open = false;
    previousTransferProgress = null;
    transferGraphSamples = [];
    return;
  }
  card.hidden = false;
  const progress = await getTransferProgress(generation);
  if (!progress) return;
  if (card.classList.contains('transfer-error')) {
    card.classList.remove('transfer-error');
    diagnostics.open = false;
  }
  const now = performance.now();
  const previous = previousTransferProgress?.generation === generation
    ? previousTransferProgress
    : null;
  const confirmed = progress.role === 'guest' ? progress.hostStoredBytes : progress.bytes;
  let rate = previous?.rate ?? null;
  let rateAt = previous?.rateAt ?? now;
  if (previous && now > previous.at && confirmed > previous.confirmed) {
    const sampleRate = (confirmed - previous.confirmed) / ((now - previous.at) / 1000);
    rate = rate === null ? sampleRate : rate * 0.6 + sampleRate * 0.4;
    rateAt = now;
  } else if (now - rateAt > 10_000) {
    rate = null;
  }
  previousTransferProgress = { generation, at: now, confirmed, rate, rateAt };

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
    updateTransferGraph(now, sendMbps, rate);
    const pendingSeconds = progress.pendingFrames / TARGET_RATE;
    const estimatedSeconds = rate > 0 ? progress.pendingBytes / rate : null;
    const totalStored = progress.bytes > 0
      ? Math.min(1, progress.hostStoredBytes / progress.bytes)
      : 0;
    bar.value = totalStored;
    let state = 'ホストに保存済み';
    if (progress.pendingBytes > 0) {
      state = estimatedSeconds === null
        ? `ホストへの転送待ち ${formatTransferMegabytes(progress.pendingBytes)}`
        : `ホストへ転送中・残り約${Math.ceil(estimatedSeconds)}秒`;
    } else if (recording) {
      state = '録音中・現在の分はホストに保存済み';
    } else if (progress.pending) {
      state = '録音終了分の保存確認中';
    }
    text.textContent =
      `この端末に保存済み ${formatTransferMegabytes(progress.bytes)} · ホストに保存済み ${formatTransferMegabytes(progress.hostStoredBytes)} · ${state}`;
    details.textContent =
      `未送信 ${formatTransferMegabytes(backlog.unsubmittedBytes)} · 送信中 ${formatTransferMegabytes(backlog.sendingBytes)} · 保存確認待ち ${formatTransferMegabytes(backlog.awaitingAckBytes)} · 未転送音声 ${pendingSeconds.toFixed(1)} 秒 · 保存確認速度 ${rate > 0 ? `${(rate * 8 / 1_000_000).toFixed(2)} Mbps` : '—'}`;
    return;
  }

  const audioSeconds = progress.frames / TARGET_RATE;
  const saveRate = rate > 0 ? `${(rate * 8 / 1_000_000).toFixed(2)} Mbps` : '—';
  const guestProgress = roomCall.remoteTransferProgress;
  const guestIsFresh = guestProgress && now - guestProgress.receivedAt <= 6_000;
  const guestTotalBytes = guestIsFresh ? guestProgress.localBytes : 0;
  bar.value = guestTotalBytes > 0 ? Math.min(1, progress.bytes / guestTotalBytes) : 0;
  let state = 'ゲストの録音データを待っています';
  if (recording) state = 'ゲスト録音中・受信した音声を保存しています';
  else if (progress.pending) state = '録音終了分の保存確認中';
  else if (progress.bytes > 0) state = '受信・保存済み';
  const totalLabel = guestIsFresh
    ? ` / ゲスト録音済み ${formatTransferMegabytes(guestTotalBytes)}`
    : '';
  updateTransferGraph(now, guestIsFresh ? guestProgress.sendMbps : null, rate);
  text.textContent =
    `この端末に保存済み ${formatTransferMegabytes(progress.bytes)}${totalLabel} · 音声 ${audioSeconds.toFixed(1)} 秒 · ${state}`;
  details.textContent = guestIsFresh
    ? `ゲスト端末の未送信 ${formatTransferMegabytes(guestProgress.unsubmittedBytes)} · 送信中 ${formatTransferMegabytes(guestProgress.sendingBytes)} · 保存確認待ち ${formatTransferMegabytes(guestProgress.awaitingAckBytes)} · 送出速度 ${guestProgress.sendMbps === null ? '—' : `${guestProgress.sendMbps.toFixed(2)} Mbps`} · 保存確認速度 ${saveRate} · manifest ${progress.completeTakes}/${progress.totalTakes}`
    : `ゲスト端末の送信状況は未受信または更新停止中です · 保存確認速度 ${saveRate} · manifest ${progress.completeTakes}/${progress.totalTakes}`;
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
    throw new Error('受信したtakeのセッションまたは接続が一致しません。');
  }
  const takeId = incomingTakeId(metadata.generation, metadata.takeId);
  const existingTake = await runRequest('takes', 'get', takeId);
  const existingChunk = await runRequest('chunks', 'get', [takeId, metadata.sequence]);
  if (existingChunk) {
    if (!existingTake || existingChunk.sha256 !== sha256 ||
        existingChunk.startFrame !== metadata.startFrame || existingChunk.frames !== metadata.frames) {
      throw new Error('同じチャンク番号に異なる音源hashが届きました。');
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
      throw new Error('この参加者の受信音源が2時間上限を超えました。');
    }
  }
  const take = existingTake || {
    id: takeId,
    sessionId: activeSession.id,
    sourceTakeId: metadata.takeId,
    transferGeneration: metadata.generation,
    participant: metadata.participant,
    number: metadata.takeNumber,
    startedAt: metadata.startedAt,
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
      !validChunkPosition) {
    throw new Error('受信チャンクが既存takeの順序またはメタデータと一致しません。');
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
  if (takeStillRecording) transaction.objectStore('takes').put(nextTake);
  await done;
  if (takeStillRecording) {
    receivedTransferFrames.set(metadata.generation, totalReceivedFrames + metadata.frames);
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
    throw new Error('受信したmanifestのセッションまたは接続が一致しません。');
  }
  const takeId = incomingTakeId(manifest.generation, manifest.takeId);
  const take = await runRequest('takes', 'get', takeId);
  if (!take || take.frames !== manifest.frames || take.chunks !== manifest.chunks ||
      take.sourceTakeId !== manifest.takeId || take.participant !== manifest.participant ||
      take.startedAt !== manifest.startedAt || take.number !== manifest.takeNumber) {
    throw new Error('manifestとホスト保存済みチャンクの内容が一致しません。');
  }
  const savedChunks = await loadTakeChunks(takeId);
  await verifyIncomingStoredTake(take, savedChunks);
  if (take.hostStored) {
    return;
  }
  const nextTake = {
    ...take,
    status: manifest.status,
    endedAt: manifest.startedAt + (manifest.frames / TARGET_RATE) * 1000,
    tailUnknown: manifest.tailUnknown,
    hostStored: true
  };
  await persistTake(nextTake);
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
      errorText.textContent = `録音一覧を更新できませんでした: ${error.message}`;
    });
  }, 2000);
}

async function refreshSessionList() {
  const sessions = (await loadAll('sessions')).sort((left, right) => right.createdAt - left.createdAt);
  const takes = await loadAll('takes');
  sessionList.replaceChildren();
  if (!sessions.length) {
    sessionList.innerHTML = '<p class="empty-state">保存済みのセッションはありません。</p>';
    return;
  }
  for (const session of sessions) {
    const sessionTakes = takes.filter((take) => take.sessionId === session.id);
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
    meta.textContent = `${session.participant} · ${sessionTakes.length} take · ${formatBytes(totalBytes)}`;
    const openButton = document.createElement('button');
    openButton.className = 'session-open';
    openButton.type = 'button';
    openButton.textContent = '開く →';
    openButton.addEventListener('click', () => { void openSession(session); });
    info.append(name, meta);
    row.append(info, openButton);
    sessionList.append(row);
  }
}

function takeStatusLabel(take) {
  if (take.status === 'recording') return [take.remote ? '受信中' : '録音中断', 'recording'];
  if (take.status === 'recovered') return ['復旧データ', 'recovered'];
  return ['保存完了', ''];
}

async function renderTakes() {
  if (!activeSession) return;
  const takes = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id)
    .sort((left, right) => left.startedAt - right.startedAt);
  takeList.replaceChildren();
  $('takeCount').textContent = `${takes.length} ${takes.length === 1 ? 'take' : 'takes'}`;
  if (!takes.length) {
    takeList.innerHTML = '<p class="empty-state">録音したtakeがここに表示されます。</p>';
    return;
  }
  for (const take of takes) {
    const row = document.createElement('article');
    row.className = 'take-row';
    const info = document.createElement('div');
    info.className = 'take-info';
    const title = document.createElement('p');
    title.className = 'take-title';
    const label = document.createElement('span');
    label.textContent = `${take.remote ? `${take.participant} · ` : ''}Take ${String(take.number).padStart(2, '0')}`;
    const [status, badgeClass] = takeStatusLabel(take);
    const badge = document.createElement('span');
    badge.className = `take-badge${badgeClass ? ` ${badgeClass}` : ''}`;
    badge.textContent = status;
    title.append(label, badge);
    const meta = document.createElement('p');
    meta.className = 'take-meta';
    const duration = (take.frames || 0) / TARGET_RATE;
    const quality = take.status === 'recovered' ? ' · 保存済みチャンクから復旧' : '';
    const transfer = take.transferGeneration && !take.remote
      ? take.hostStored
        ? ' · ホスト端末に保存済み'
        : ' · ホスト端末への保存確認待ち'
      : '';
    const bytes = take.bytes ? ` · ${formatBytes(take.bytes)}` : '';
    meta.textContent = `${new Date(take.startedAt).toLocaleString('ja-JP')} · ${formatDuration(duration)}${bytes}${quality}${transfer}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'take-actions';
    if (roomCall?.isGuest !== true) {
      const exportButton = document.createElement('button');
      exportButton.className = 'take-action';
      exportButton.type = 'button';
      exportButton.textContent = take.status === 'recovered' ? '復旧 WAV を保存' : 'WAV を保存';
      exportButton.disabled = take.status === 'recording' || !take.chunks ||
        (take.remote && take.hostStored !== true);
      exportButton.addEventListener('click', () => { void exportTake(take); });
      actions.append(exportButton);
    }
    row.append(info, actions);
    takeList.append(row);
  }
}

async function openSession(session) {
  activeSession = session;
  $('studioTitle').textContent = roomCall?.inviteMode ? 'ゲスト収録' : session.name;
  $('participantLabel').textContent = session.participant;
  $('waveformParticipant').textContent = session.participant;
  waveformHistory.fill(0);
  waveformCount = 0;
  waveformElapsedSeconds = 0;
  lastRulerSecond = -1;
  $('timer').textContent = '00:00';
  setupView.hidden = true;
  studioView.hidden = false;
  $('waveformState').textContent = '待機中';
  $('waveformState').classList.remove('live');
  if (roomCall?.isActive && mediaStream && !recording) startLocalPreview(mediaStream);
  if (waveformFrame === null) drawWaveform();
  errorText.textContent = '';
  setStatus('録音を始める準備ができました');
  await renderTakes();
  const takes = (await loadAll('takes'))
    .filter((take) => take.sessionId === session.id)
    .sort((left, right) => left.startedAt - right.startedAt);
  const savedFrames = takes.filter((take) => !take.remote)
    .reduce((total, take) => total + (take.frames || 0), 0);
  sessionLimitReached = savedFrames >= MAX_SESSION_FRAMES;
  updateRecordButtonAvailability();
  if (sessionLimitReached) setStatus('このセッションは2時間の録音上限に達しています');
  $('chunkCount').textContent = String(takes.at(-1)?.chunks || 0);
  await updateSessionSavedSize();
}

async function detectDevices(requestPermission = true) {
  const button = $('detectDevices');
  button.disabled = true;
  button.textContent = '確認中…';
  $('setupMessage').textContent = '';
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('デバイス一覧を取得できません。HTTPS または localhost で開いてください。');
    if (requestPermission) {
      if (!navigator.mediaDevices.getUserMedia) throw new Error('マイク取得に対応していません。Chrome または Edge を使用してください。');
      const temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      temporaryStream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    micDevice.replaceChildren();
    if (!microphones.length) {
      micDevice.add(new Option('マイクが見つかりません', ''));
      $('setupMessage').textContent = '利用可能なマイクが見つかりませんでした。';
    } else {
      for (const [index, device] of microphones.entries()) {
        micDevice.add(new Option(device.label || `マイク ${index + 1}`, device.deviceId));
      }
      const labelsVisible = microphones.every((device) => device.label);
      $('setupMessage').textContent = labelsVisible
        ? `${microphones.length} 台のマイクを検出しました。`
        : `${microphones.length} 台のマイクを検出しました。名前を表示するには「デバイスを検出」を押してください。`;
    }
  } catch (error) {
    $('setupMessage').textContent = error.name === 'NotAllowedError'
      ? 'マイクの使用が許可されませんでした。ブラウザーのサイト設定を確認してください。'
      : `デバイスを検出できませんでした: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'デバイスを検出';
  }
}

async function ensureCaptureStream() {
  if (mediaStream?.getAudioTracks().some((track) => track.readyState === 'live')) return mediaStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('マイク取得に対応していません。Chrome または Edge を使用してください。');
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: micDevice.value }, ...RAW_AUDIO_CONSTRAINTS, sampleRate: TARGET_RATE }
  });
  return mediaStream;
}

async function checkRecordingReadiness() {
  const stream = mediaStream || await ensureCaptureStream();
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live' || track.muted) {
    throw new Error('有効なマイク入力がありません。');
  }
  if (!window.AudioContext) throw new Error('AudioContextを利用できません。');
  const context = new AudioContext({ sampleRate: TARGET_RATE });
  try {
    if (context.sampleRate !== TARGET_RATE) throw new Error('48 kHzのAudioContextを作成できません。');
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
}

async function commitChunk(samples, isFinal, startFrame) {
  if (!activeTake || samples.length === 0) return;
  if (startFrame !== capturedFrames) {
    throw new Error(`録音フレームが不連続です（期待 ${capturedFrames} / 取得 ${startFrame}）。不明区間を正常音声として扱わず録音を停止しました。`);
  }
  if (!canQueueRecordingCommit(pendingCommits, isFinal)) {
    throw new Error('IndexedDBへの保存待ちが60秒分に達しました。データ欠落を防ぐため録音を停止しました。');
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
    const take = { ...activeTake };
    take.frames += samples.length;
    take.chunks += 1;
    take.bytes += wav.size;
    transaction.objectStore('takes').put(take);
    await done;
    activeTake = take;
  }).catch((error) => {
    commitError = error;
    throw error;
  }).finally(() => {
    pendingCommits -= 1;
  });
  await commitChain;
  const take = activeTake;
  if (!take) throw new Error('保存済み録音takeが見つかりません。');
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

async function createTake({ scheduledStartAt = null, event = null } = {}) {
  errorText.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('AudioWorklet 録音に対応していません。Chrome または Edge を使用してください。');
  }
  await stopDiagnostics({ stopCapture: !roomCall?.isActive });
  await ensureCaptureStream();
  stopLocalPreview();
  audioContext = new AudioContext({ sampleRate: TARGET_RATE });
  if (audioContext.sampleRate !== TARGET_RATE) {
    throw new Error(`この端末のAudioContextは ${audioContext.sampleRate} Hzです。48,000 Hzが必要です。`);
  }
  const sessionTakes = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id && !take.remote);
  const savedFrames = sessionTakes.reduce((total, take) => total + (take.frames || 0), 0);
  takeFrameLimit = remainingSessionFrames(savedFrames);
  if (takeFrameLimit === 0) {
    sessionLimitReached = true;
    updateRecordButtonAvailability();
    throw new Error('このセッションは2時間の録音上限に達しています。新しいセッションを作成してください。');
  }
  sessionLimitReached = false;
  activeTake = {
    id: crypto.randomUUID(),
    sessionId: activeSession.id,
    number: sessionTakes.length + 1,
    participant: activeSession.participant,
    status: 'recording',
    transferGeneration: roomCall?.localRole === 'guest' ? roomCall.authFields?.generation : null,
    hostStored: roomCall?.localRole === 'guest' ? false : null,
    startedAt: scheduledStartAt === null
      ? Date.now()
      : Date.now() + (scheduledStartAt - performance.now()),
    endedAt: null,
    frames: 0,
    chunks: 0,
    bytes: 0,
    tailUnknown: false
  };
  await persistTake(activeTake);
  nextSequence = 0;
  capturedFrames = 0;
  $('chunkCount').textContent = '0';
  lastPeak = 0;
  waveformHistory.fill(0);
  waveformCount = 0;
  waveformElapsedSeconds = 0;
  lastWaveformSample = performance.now();
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
      const timestamp = audioContext?.getOutputTimestamp?.();
      const observedAt = timestamp && Number.isFinite(timestamp.performanceTime) &&
        Number.isFinite(timestamp.contextTime)
        ? timestamp.performanceTime + (data.contextTime - timestamp.contextTime) * 1000
        : performance.now() + (data.contextTime - (audioContext?.currentTime ?? data.contextTime)) * 1000;
      if (data.event) {
        roomCall?.reportRecordingStarted(data.event, observedAt, data.frame);
      }
      takeStartedAt = observedAt;
      waveformHistory.fill(0);
      waveformCount = 0;
      waveformElapsedSeconds = 0;
      lastWaveformSample = observedAt;
      lastRulerSecond = -1;
      roomCall?.beginRecordingWaveform(observedAt);
      scheduledRecordingStartAt = null;
      updateRecordingPreparation();
      setStatus('録音中 · 端末へ順次保存しています', 'recording');
      if (roomCall?.isGuest) $('hostRecordingStatus').textContent = 'ホストに合わせて録音中です';
      $('waveformState').textContent = 'LIVE';
      $('waveformState').classList.add('live');
      return;
    }
    if (data.type === 'level') {
      updateMeter(data.peak);
      return;
    }
    if (data.type === 'audio') {
      if (commitError) return;
      void commitChunk(data.samples, data.final, data.startFrame).catch((error) => {
        errorText.textContent = error.message || `チャンクを保存できませんでした: ${error}`;
        void stopRecording(errorText.textContent);
      });
      return;
    }
    if (data.type === 'limit-reached' && recording) {
      void stopRecording().then((saved) => setMessage(
        saved
          ? 'このセッションの2時間上限に達したため、録音を停止して保存しました。'
          : 'このセッションの2時間上限に達したため録音を停止しました。保存状態を確認してください。',
        !saved
      ));
    }
  };
  sourceNode.connect(analyserNode);
  analyserNode.connect(recorderNode);
  recorderNode.connect(silentGain).connect(audioContext.destination);
  const track = mediaStream.getAudioTracks()[0];
  if (!track) throw new Error('有効なマイク入力がありません。');
  clearRecordingTrackMonitor();
  const trackMonitor = monitorRecordingTrack(track, {
    isRecording: () => recording,
    onMuted: () => {
      setStatus('マイク入力が一時停止しています。復帰を待っています…');
      $('meterHint').textContent = '入力一時停止 · 復帰待ち';
    },
    onUnmuted: () => {
      setStatus('録音中 · 端末へ順次保存しています', 'recording');
      $('meterHint').textContent = '入力を検出中';
    },
    onEnded: () => {
      void stopRecording('マイク入力が終了しました。保存済みチャンクを復旧データとして残しました。')
        .catch((error) => setMessage(`録音を停止できませんでした: ${error.message}`, true));
    },
    onMuteTimeout: () => {
      setStatus('マイク入力が一時停止中です · 録音を継続しています');
      setMessage('マイク入力の一時停止が続いています。入力が復帰するまで録音を継続します。', true);
    }
  });
  cleanupRecordingTrackMonitor = trackMonitor.cleanup;
  audioContext.addEventListener('statechange', () => {
    if (recording && audioContext?.state === 'closed') {
      void stopRecording('AudioContext が閉じられました。保存済みチャンクを復旧データとして残しました。')
        .catch((error) => setMessage(`録音を停止できませんでした: ${error.message}`, true));
    }
  });
  await audioContext.resume();
  if (track.readyState !== 'live') throw new Error('録音開始前にマイク入力が終了しました。デバイスを確認して再試行してください。');
  if (scheduledStartAt !== null && scheduledStartAt < performance.now() + 250) {
    throw new Error('同期開始の準備が間に合いませんでした。録音準備を確認して再試行してください。');
  }
  const startAt = scheduledStartAt === null
    ? null
    : audioContextTimeAtPerformanceTime(scheduledStartAt);
  recorderNode.port.postMessage({
    type: 'start',
    maximumFrames: takeFrameLimit,
    startAt,
    eventId: event?.eventId,
    sequence: event?.sequence
  });
  recording = true;
  trackMonitor.checkCurrentMute();
  takeStartedAt = scheduledStartAt ?? performance.now();
  elapsedTimer = window.setInterval(updateTimer, 200);
  recordButton.disabled = true;
  stopButton.disabled = false;
  const scheduled = scheduledStartAt !== null;
  setStatus(scheduled ? '録音開始を予約しました · 端末へ順次保存します' : '録音中 · 端末へ順次保存しています', scheduled ? 'ready' : 'recording');
  $('waveformState').textContent = scheduled ? '準備中' : 'LIVE';
  $('waveformState').classList.toggle('live', !scheduled);
  if (!scheduled) updateRecordingPreparation();
}

async function stopDiagnostics({ stopCapture = true } = {}) {
  clearRecordingTrackMonitor();
  if (sourceNode) sourceNode.disconnect();
  if (recorderNode) {
    recorderNode.port.onmessage = null;
    recorderNode.disconnect();
  }
  if (silentGain) silentGain.disconnect();
  if (stopCapture) mediaStream?.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== 'closed') await audioContext.close();
  sourceNode = null;
  analyserNode = null;
  recorderNode = null;
  silentGain = null;
  if (stopCapture) mediaStream = null;
  audioContext = null;
  waveformSamples = null;
}

async function stopRecording(recoveryReason = null) {
  if (!activeTake || finalizing) return !recording && !finalizing;
  finalizing = true;
  recording = false;
  scheduledRecordingStartAt = null;
  updateRecordingPreparation();
  roomCall?.endRecordingWaveform();
  roomCall?.setHostRecordingState(false);
  window.clearInterval(elapsedTimer);
  window.clearTimeout(takeRefreshTimer);
  takeRefreshTimer = null;
  recordButton.disabled = true;
  stopButton.disabled = true;
  setStatus(recoveryReason ? '保存済みチャンクから復旧しています…' : '末尾チャンクを保存しています…');
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
    failure ||= `IndexedDB への保存に失敗しました: ${error.message}`;
  }
  await stopDiagnostics({ stopCapture: !roomCall?.isActive });
  if (roomCall?.isActive && mediaStream) startLocalPreview(mediaStream);
  const status = failure ? 'recovered' : 'stopped';
  activeTake = {
    ...activeTake,
    status,
    endedAt: Date.now(),
    tailUnknown: Boolean(failure),
    recoveryReason: failure ? String(failure) : null
  };
  try {
    await persistTake(activeTake);
  } catch (error) {
    failure ||= `take の完了状態を保存できませんでした: ${error.message}`;
  }
  if (activeTake.transferGeneration) roomCall?.notifyTakeFinalized(activeTake);
  $('timer').textContent = formatDuration(activeTake.frames / TARGET_RATE);
  stopButton.disabled = true;
  finalizing = false;
  takeFrameLimit = 0;
  setStatus(failure ? '復旧用データを保存しました。未確定の末尾は含まれません。' : '録音データ保存済み · WAVを書き出せます', failure ? 'ready' : 'saved');
  $('waveformState').textContent = '待機中';
  $('waveformState').classList.remove('live');
  if (failure) errorText.textContent = `${failure} 保存済みチャンクは一覧から復旧 WAV として書き出せます。`;
  activeTake = null;
  await renderTakes();
  const sessionFrames = (await loadAll('takes'))
    .filter((take) => take.sessionId === activeSession.id && !take.remote)
    .reduce((total, take) => total + (take.frames || 0), 0);
  sessionLimitReached = sessionFrames >= MAX_SESSION_FRAMES;
  updateRecordButtonAvailability();
  if (sessionLimitReached) setStatus('このセッションは2時間の録音上限に達しています');
  await updateSessionSavedSize();
  await refreshSessionList();
  if (!failure) setMessage('録音データ（WAVチャンク）をブラウザー内に保存しました。音声ファイルとして保存するには「WAVを保存」を押してください。');
  return !failure;
}

function audioContextTimeAtPerformanceTime(targetTime) {
  const timestamp = audioContext?.getOutputTimestamp?.();
  if (timestamp && Number.isFinite(timestamp.contextTime) && Number.isFinite(timestamp.performanceTime)) {
    return timestamp.contextTime + (targetTime - timestamp.performanceTime) / 1000;
  }
  return audioContext.currentTime + (targetTime - performance.now()) / 1000;
}

async function startRecording(remoteSchedule = null) {
  if (recording) return true;
  if (finalizing || starting || !activeSession) return false;
  if (roomCall?.isActive && !roomCall.isGuest && !roomCall.canStartRecording) {
    errorText.textContent = '通話接続と双方の録音準備が完了してから録音を開始してください。';
    return false;
  }
  starting = true;
  scheduledRecordingStartAt = remoteSchedule?.startAt ?? null;
  updateRecordingPreparation();
  recordButton.disabled = true;
  try {
    let schedule = remoteSchedule;
    if (roomCall?.isPeerReadyForRecording && !roomCall.isGuest && !schedule) {
      const clockOffsetMs = await roomCall.synchronizeClock();
      schedule = {
        startAt: performance.now() + 5000,
        clockOffsetMs,
        event: { eventId: crypto.randomUUID(), sequence: roomCall.recordingSequence + 1 }
      };
      scheduledRecordingStartAt = schedule.startAt;
      updateRecordingPreparation();
    }
    await createTake({
      scheduledStartAt: schedule?.startAt ?? null,
      event: schedule?.event ?? null
    });
    if (recording && schedule) {
      if (!roomCall.isGuest) roomCall.setHostRecordingState(
        true,
        schedule.startAt,
        schedule.clockOffsetMs,
        schedule.event.eventId
      );
    }
    return recording;
  } catch (error) {
    await stopDiagnostics({ stopCapture: !roomCall?.isActive });
    if (activeTake?.status === 'recording') {
      activeTake = { ...activeTake, status: 'recovered', endedAt: Date.now(), tailUnknown: true, recoveryReason: error.message };
      await persistTake(activeTake).catch((saveError) => { errorText.textContent = `${error.message} take の状態も保存できませんでした: ${saveError.message}`; });
      activeTake = null;
      await renderTakes();
    }
    errorText.textContent ||= error.name === 'NotAllowedError'
      ? 'マイクの使用が許可されませんでした。ブラウザーのサイト設定を確認してください。'
      : `録音を開始できませんでした: ${error.message}`;
    setStatus('録音を開始できませんでした');
    recordButton.disabled = false;
    stopButton.disabled = true;
    scheduledRecordingStartAt = null;
    return false;
  } finally {
    starting = false;
    updateRecordingPreparation();
    updateRecordButtonAvailability();
    if (roomCall?.isActive && !recording && mediaStream) startLocalPreview(mediaStream);
  }
}

function applyHostRecordingState(isRecording, schedule = null) {
  const previousState = lastHostRecordingState;
  lastHostRecordingState = isRecording;
  hostRecordingCommand = hostRecordingCommand.then(async () => {
    if (isRecording) {
      $('hostRecordingStatus').textContent = 'ホストの録音に合わせて録音を開始しています…';
      const started = recording || await startRecording(schedule);
      $('hostRecordingStatus').textContent = recording
        ? scheduledRecordingStartAt !== null
          ? 'ホストの録音開始を待っています。開始表示が切り替わるまでお待ちください。'
          : 'ホストに合わせて録音中です'
        : 'この端末では録音を開始できませんでした。下のエラーを確認してください。';
      return started;
    }
    if (recording) {
      $('hostRecordingStatus').textContent = 'ホストの停止に合わせて保存しています…';
      const stopped = await stopRecording();
      $('hostRecordingStatus').textContent = stopped
        ? 'ホストに合わせて停止し、この端末に保存しました'
        : '停止または保存を確認できませんでした。エラーを確認してください。';
      return stopped;
    }
    $('hostRecordingStatus').textContent = previousState
      ? 'ホストに合わせて停止し、この端末に保存しました'
      : 'ホストの録音を待っています';
    return true;
  }).catch((error) => {
    errorText.textContent = `ホストの録音状態を反映できませんでした: ${error.message}`;
    $('hostRecordingStatus').textContent = '録音状態を反映できませんでした。エラーを確認してください。';
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

async function exportTake(take) {
  const totalBytes = 44 + take.frames * BYTES_PER_FRAME;
  if (!Number.isSafeInteger(take.frames) || take.frames <= 0 || totalBytes > MAX_WAV_BYTES) {
    setMessage('WAV は1 GiB以下で書き出してください。', true);
    return;
  }
  try {
    const fileHandle = typeof window.showSaveFilePicker === 'function'
      ? await window.showSaveFilePicker({
          suggestedName: makeRecordingFilename(activeSession, take),
          types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }]
        })
      : null;
    const chunks = await getTakeChunks(take.id);
    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      try {
        await writePcm24Wav(take, chunks, writable);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort(error);
        } catch (abortError) {
          throw new AggregateError([error, abortError], 'WAVの書き込みと中断処理の両方に失敗しました。');
        }
        throw error;
      }
      setMessage('PCM24 WAVを保存先へ書き出しました。');
      return;
    }
    if (totalBytes > BLOB_DOWNLOAD_LIMIT) {
      setMessage('このブラウザーでは256 MBを超えるWAVを安全に保存できません。対応するChromeまたはEdgeで保存先を選択してください。', true);
      return;
    }
    const blobParts = [];
    await writePcm24Wav(take, chunks, {
      async write(data) {
        blobParts.push(data);
      }
    });
    const output = new Blob(blobParts, { type: 'audio/wav' });
    const url = URL.createObjectURL(output);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = makeRecordingFilename(activeSession, take);
    downloadLink.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setMessage('ブラウザーにWAVのダウンロードを要求しました。保存完了はダウンロード一覧で確認してください。');
  } catch (error) {
    if (error.name === 'AbortError') {
      setMessage('WAVの保存をキャンセルしました。');
      return;
    }
    setMessage(`WAV を書き出せませんでした: ${error.message}`, true);
  }
}

async function recoverInterruptedTakes() {
  const takes = await loadAll('takes');
  const interrupted = takes.filter((take) => take.status === 'recording');
  for (const take of interrupted) {
    await persistTake({
      ...take,
      status: 'recovered',
      endedAt: Date.now(),
      tailUnknown: true,
      recoveryReason: 'タブまたはブラウザーが録音終了前に閉じられました。最後の確定チャンクまでを復旧対象にしています。'
    });
  }
  if (interrupted.length) setMessage(`${interrupted.length} 件の中断 take を復旧用として読み込みました。`);
}

async function stopDiagnosticsOnUnload() {
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
}

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const participant = participantNameInput.value.trim();
  if (!participant || !micDevice.value) {
    $('setupMessage').textContent = '名前と録音マイクを指定してください。';
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
  const session = { id: crypto.randomUUID(), name: `収録 ${sessionName}`, participant, createdAt };
  try {
    await persistSession(session);
    activeSession = session;
    await openSession(session);
  } catch (error) {
    $('setupMessage').textContent = `セッションを保存できませんでした: ${error.message}`;
  }
});

$('detectDevices').addEventListener('click', () => { void detectDevices(); });
recordButton.addEventListener('click', () => {
  if (!roomCall?.isGuest) void startRecording();
});
stopButton.addEventListener('click', () => {
  if (!roomCall?.isGuest) void stopRecording();
});
$('backButton').addEventListener('click', async () => {
  if (recording || finalizing) {
    setMessage('録音を停止して保存してからセッション一覧へ戻ってください。', true);
    return;
  }
  if (roomCall?.isActive) {
    setMessage('通話または招待を終了してからセッション一覧へ戻ってください。', true);
    return;
  }
  activeSession = null;
  if (waveformFrame !== null) {
    window.cancelAnimationFrame(waveformFrame);
    waveformFrame = null;
  }
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
      onRecordingState: applyHostRecordingState,
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
          if (!recording) setLocalWaveformState('待機中');
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
        card.hidden = false;
        card.classList.add('transfer-error');
        $('transferProgressText').textContent = '音源の進捗を更新できません。通話の接続を確認してください。詳しいエラーは下に表示しています。';
        $('transferProgressDetails').textContent = `エラーの詳細: ${error.message}`;
        $('transferDiagnostics').open = true;
      });
    }, 1000);
  } catch (error) {
    $('setupMessage').textContent = `ローカル保存を初期化できませんでした: ${error.message}`;
    setupForm.querySelector('button[type="submit"]').disabled = true;
  }
}

void initialize();
void detectDevices(false);
