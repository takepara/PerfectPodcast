const TARGET_RATE = 48000;
const BYTES_PER_FRAME = 3;
const CHUNK_FRAMES = TARGET_RATE;
const DB_NAME = 'perfectpodcast-local-v1';
const DB_VERSION = 1;
const FALLBACK_EXPORT_LIMIT = 256 * 1024 * 1024;
const MAX_WAV_BYTES = 1024 * 1024 * 1024;
const RAW_AUDIO_CONSTRAINTS = {
  channelCount: { exact: 1 },
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
const errorText = $('errorText');
const notice = $('notice');
const meter = document.querySelector('[role="meter"]');

let database;
let activeSession = null;
let activeTake = null;
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let recorderNode = null;
let silentGain = null;
let recording = false;
let finalizing = false;
let starting = false;
let pendingCommits = 0;
let commitChain = Promise.resolve();
let commitError = null;
let nextSequence = 0;
let capturedFrames = 0;
let elapsedTimer = null;
let storageTimer = null;
let noticeTimer = null;
let takeStartedAt = 0;
let lastPeak = 0;

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

function setMessage(message, isError = false) {
  notice.textContent = message;
  notice.className = `notice show${isError ? ' error' : ''}`;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.className = 'notice'; }, 4200);
}

function updateTimer() {
  if (!recording) return;
  $('timer').textContent = formatDuration((performance.now() - takeStartedAt) / 1000);
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

async function updateStorageStatus() {
  const saved = activeSession
    ? (await loadAll('takes')).filter((take) => take.sessionId === activeSession.id).reduce((total, take) => total + (take.bytes || 0), 0)
    : 0;
  $('sessionSaved').textContent = `${(saved / 1_000_000).toFixed(2)} MB`;

  if (!navigator.storage?.estimate) {
    $('storageAvailable').textContent = '未対応';
    $('storageDetail').textContent = 'このブラウザーから保存容量を取得できません。';
    return;
  }
  const { usage, quota } = await navigator.storage.estimate();
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) {
    $('storageAvailable').textContent = '取得不可';
    $('storageDetail').textContent = 'ブラウザーが容量を返しませんでした。';
    return;
  }
  const available = Math.max(0, quota - usage);
  const usedPercent = Math.min(100, usage / quota * 100);
  $('storageAvailable').textContent = formatBytes(available);
  $('storageDetail').textContent = `使用中 ${formatBytes(usage)} / 推定上限 ${formatBytes(quota)}`;
  $('storageFill').style.width = `${usedPercent}%`;
  $('storageFill').classList.toggle('low', available < 250_000_000);
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
  if (take.status === 'recording') return ['録音中断', 'recording'];
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
    label.textContent = `Take ${String(take.number).padStart(2, '0')}`;
    const [status, badgeClass] = takeStatusLabel(take);
    const badge = document.createElement('span');
    badge.className = `take-badge${badgeClass ? ` ${badgeClass}` : ''}`;
    badge.textContent = status;
    title.append(label, badge);
    const meta = document.createElement('p');
    meta.className = 'take-meta';
    const duration = (take.frames || 0) / TARGET_RATE;
    const quality = take.status === 'recovered' ? ' · 保存済みチャンクから復旧' : '';
    const bytes = take.bytes ? ` · ${formatBytes(take.bytes)}` : '';
    meta.textContent = `${new Date(take.startedAt).toLocaleString('ja-JP')} · ${formatDuration(duration)}${bytes}${quality}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'take-actions';
    const exportButton = document.createElement('button');
    exportButton.className = 'take-action';
    exportButton.type = 'button';
    exportButton.textContent = take.status === 'recovered' ? '復旧 WAV を保存' : 'WAV を保存';
    exportButton.disabled = take.status === 'recording' || !take.chunks;
    exportButton.addEventListener('click', () => { void exportTake(take); });
    actions.append(exportButton);
    row.append(info, actions);
    takeList.append(row);
  }
}

async function openSession(session) {
  activeSession = session;
  $('studioTitle').textContent = session.name;
  $('participantLabel').textContent = session.participant;
  $('timer').textContent = '00:00';
  setupView.hidden = true;
  studioView.hidden = false;
  errorText.textContent = '';
  setStatus('録音を始める準備ができました');
  await renderTakes();
  const takes = (await loadAll('takes'))
    .filter((take) => take.sessionId === session.id)
    .sort((left, right) => left.startedAt - right.startedAt);
  $('chunkCount').textContent = String(takes.at(-1)?.chunks || 0);
  await updateStorageStatus();
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

function makeWavHeader(frameCount) {
  const dataBytes = frameCount * BYTES_PER_FRAME;
  if (dataBytes > 0xffffffff - 36) throw new Error('このtakeは通常 WAV のサイズ上限を超えています。分割書き出しは次の実装段階で対応します。');
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * BYTES_PER_FRAME, true);
  view.setUint16(32, BYTES_PER_FRAME, true);
  view.setUint16(34, 24, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

function createPcm24Wav(samples) {
  const data = new ArrayBuffer(samples.length * BYTES_PER_FRAME);
  const view = new DataView(data);
  let offset = 0;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0
      ? Math.round(clamped * 8388608)
      : Math.min(8388607, Math.round(clamped * 8388607));
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
    offset += BYTES_PER_FRAME;
  }
  return new Blob([makeWavHeader(samples.length), data], { type: 'audio/wav' });
}

async function commitChunk(samples, isFinal, startFrame) {
  if (!activeTake || samples.length === 0) return;
  if (startFrame !== capturedFrames) {
    throw new Error(`録音フレームが不連続です（期待 ${capturedFrames} / 取得 ${startFrame}）。不明区間を正常音声として扱わず録音を停止しました。`);
  }
  if (!isFinal && pendingCommits > 0) {
    throw new Error('チャンク保存が1秒以上遅れています。未確定データを増やさないため録音を停止しました。');
  }
  if (pendingCommits >= 2) {
    throw new Error('保存待ちが2チャンクに達しました。データ欠落を防ぐため録音を停止しました。');
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
    $('chunkCount').textContent = String(take.chunks);
    await updateStorageStatus();
    await renderTakes();
  }).catch((error) => {
    commitError = error;
    throw error;
  }).finally(() => {
    pendingCommits -= 1;
  });
  await commitChain;
}

async function createTake() {
  errorText.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('AudioWorklet 録音に対応していません。Chrome または Edge を使用してください。');
  }
  await stopDiagnostics();
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: micDevice.value }, ...RAW_AUDIO_CONSTRAINTS, sampleRate: TARGET_RATE }
  });
  audioContext = new AudioContext({ sampleRate: TARGET_RATE });
  const settings = mediaStream.getAudioTracks()[0].getSettings();
  if (audioContext.sampleRate !== TARGET_RATE || (settings.sampleRate && settings.sampleRate !== TARGET_RATE)) {
    throw new Error(`この端末の入力は ${settings.sampleRate || audioContext.sampleRate} Hz です。Step 1 は 48,000 Hz のみ対応します。`);
  }
  const sessionTakes = (await loadAll('takes')).filter((take) => take.sessionId === activeSession.id);
  activeTake = {
    id: crypto.randomUUID(),
    sessionId: activeSession.id,
    number: sessionTakes.length + 1,
    status: 'recording',
    startedAt: Date.now(),
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
  updateMeter(0);
  pendingCommits = 0;
  commitError = null;
  commitChain = Promise.resolve();
  finalizing = false;

  await audioContext.audioWorklet.addModule('./recorder-worklet.js');
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  recorderNode = new AudioWorkletNode(audioContext, 'perfectpodcast-local-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit'
  });
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  recorderNode.port.onmessage = ({ data }) => {
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
    }
  };
  sourceNode.connect(recorderNode);
  recorderNode.connect(silentGain).connect(audioContext.destination);
  const track = mediaStream.getAudioTracks()[0];
  track.addEventListener('ended', () => {
    if (recording) {
      void stopRecording('マイク入力が終了しました。保存済みチャンクを復旧データとして残しました。')
        .catch((error) => setMessage(`録音を停止できませんでした: ${error.message}`, true));
    }
  }, { once: true });
  track.addEventListener('mute', () => {
    if (recording) {
      void stopRecording('マイク入力が一時停止しました。保存済みチャンクを復旧データとして残しました。')
        .catch((error) => setMessage(`録音を停止できませんでした: ${error.message}`, true));
    }
  }, { once: true });
  audioContext.addEventListener('statechange', () => {
    if (recording && audioContext?.state === 'closed') {
      void stopRecording('AudioContext が閉じられました。保存済みチャンクを復旧データとして残しました。')
        .catch((error) => setMessage(`録音を停止できませんでした: ${error.message}`, true));
    }
  });
  await audioContext.resume();
  recorderNode.port.postMessage({ type: 'start' });
  recording = true;
  takeStartedAt = performance.now();
  elapsedTimer = window.setInterval(updateTimer, 200);
  storageTimer = window.setInterval(() => { void updateStorageStatus().catch((error) => setMessage(`保存容量を確認できませんでした: ${error.message}`, true)); }, 15000);
  recordButton.disabled = true;
  stopButton.disabled = false;
  setStatus('録音中 · 端末へ順次保存しています', 'recording');
}

async function stopDiagnostics() {
  if (!audioContext) return;
  if (sourceNode) sourceNode.disconnect();
  if (recorderNode) {
    recorderNode.port.onmessage = null;
    recorderNode.disconnect();
  }
  if (silentGain) silentGain.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  if (audioContext.state !== 'closed') await audioContext.close();
  sourceNode = null;
  recorderNode = null;
  silentGain = null;
  mediaStream = null;
  audioContext = null;
}

async function stopRecording(recoveryReason = null) {
  if (!activeTake || finalizing) return;
  finalizing = true;
  recording = false;
  window.clearInterval(elapsedTimer);
  window.clearInterval(storageTimer);
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
  await stopDiagnostics();
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
  $('timer').textContent = formatDuration(activeTake.frames / TARGET_RATE);
  recordButton.disabled = false;
  stopButton.disabled = true;
  finalizing = false;
  setStatus(failure ? '復旧用データを保存しました。未確定の末尾は含まれません。' : '保存完了 · WAV を書き出せます', failure ? 'ready' : 'saved');
  if (failure) errorText.textContent = `${failure} 保存済みチャンクは一覧から復旧 WAV として書き出せます。`;
  activeTake = null;
  await renderTakes();
  await updateStorageStatus();
  await refreshSessionList();
  if (!failure) setMessage('録音を端末に保存しました。');
}

async function startRecording() {
  if (recording || finalizing || starting || !activeSession) return;
  starting = true;
  recordButton.disabled = true;
  try {
    await createTake();
  } catch (error) {
    await stopDiagnostics();
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
  } finally {
    starting = false;
  }
}

function makeFilename(take, extension = 'wav') {
  const safeName = activeSession.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'recording';
  const date = new Date(take.startedAt).toISOString().slice(0, 10);
  const recoveryTag = take.status === 'recovered' ? '_recovered' : '';
  return `${safeName}_take-${String(take.number).padStart(2, '0')}${recoveryTag}_${date}.${extension}`;
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
  if (!take.frames || totalBytes > MAX_WAV_BYTES) {
    setMessage('WAV は1 GiB以下で書き出してください。take の分割保存は次の実装段階で対応します。', true);
    return;
  }
  let writable = null;
  let fileHandle = null;
  let filePromise = null;
  if (typeof window.showSaveFilePicker === 'function') {
    filePromise = window.showSaveFilePicker({
      suggestedName: makeFilename(take),
      types: [{ description: 'PCM 24-bit WAV', accept: { 'audio/wav': ['.wav'] } }]
    });
  } else if (totalBytes > FALLBACK_EXPORT_LIMIT) {
    setMessage('このブラウザーはストリーム書き出しに未対応です。256 MB を超える WAV は Chrome / Edge で保存してください。', true);
    return;
  }
  try {
    if (filePromise) {
      fileHandle = await filePromise;
      writable = await fileHandle.createWritable();
      await writable.write(makeWavHeader(take.frames));
    }
    const chunks = await getTakeChunks(take.id);
    let exportedFrames = 0;
    const blobParts = filePromise ? null : [makeWavHeader(take.frames)];
    for (const chunk of chunks) {
      const pcm = await chunk.wav.slice(44).arrayBuffer();
      if (filePromise) await writable.write(pcm);
      else blobParts.push(pcm);
      exportedFrames += chunk.frames;
    }
    if (exportedFrames !== take.frames) throw new Error('take 台帳と保存チャンクのフレーム数が一致しません。');
    if (writable) {
      await writable.close();
      setMessage(`${makeFilename(take)} を保存しました。`);
      return;
    }
    const output = new Blob(blobParts, { type: 'audio/wav' });
    const url = URL.createObjectURL(output);
    const link = document.createElement('a');
    link.href = url;
    link.download = makeFilename(take);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setMessage(`${makeFilename(take)} をダウンロードしました。`);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (error.name !== 'AbortError') setMessage(`WAV を書き出せませんでした: ${error.message}`, true);
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
recordButton.addEventListener('click', () => { void startRecording(); });
stopButton.addEventListener('click', () => { void stopRecording(); });
$('backButton').addEventListener('click', async () => {
  if (recording || finalizing) {
    setMessage('録音を停止して保存してからセッション一覧へ戻ってください。', true);
    return;
  }
  activeSession = null;
  studioView.hidden = true;
  setupView.hidden = false;
  await refreshSessionList();
  await updateStorageStatus();
});
window.addEventListener('beforeunload', () => { void stopDiagnosticsOnUnload(); });

async function initialize() {
  try {
    database = await openDatabase();
    database.addEventListener('versionchange', () => database.close());
    await recoverInterruptedTakes();
    await refreshSessionList();
    await updateStorageStatus();
  } catch (error) {
    $('setupMessage').textContent = `ローカル保存を初期化できませんでした: ${error.message}`;
    setupForm.querySelector('button[type="submit"]').disabled = true;
  }
}

void initialize();
void detectDevices(false);
