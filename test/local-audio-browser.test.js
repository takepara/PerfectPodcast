import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

const browserPaths = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
};

async function browserScenario() {
  const { LocalAudioEngine } = await import('/prototype/local-audio-engine.js');
  const { createPcm24Wav, writePcm24Wav } = await import('/prototype/wav-export.js');
  const { openDatabase, RecordingRepository } = await import('/prototype/recording-repository.js');
  const { CommitQueue } = await import('/prototype/recording-commit-queue.js');
  const db = await openDatabase(indexedDB, 'local-audio-engine-test');
  const repository = new RecordingRepository(db);
  const queueMetrics = [];
  const contexts = [];
  const states = [];
  const engine = new LocalAudioEngine({
    createContext(options) { const context = new AudioContext(options); contexts.push(context); return context; },
    onStateChange(state) { states.push(state); }
  });
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 48000 } });
  await engine.startPreview(microphone);
  await engine.checkReadiness(microphone);
  const context = engine.context;
  const destination = context.createMediaStreamDestination();
  const signal = context.createOscillator();
  const gain = context.createGain();
  signal.frequency.value = 997;
  gain.gain.value = 0.25;
  signal.connect(gain).connect(destination);
  signal.start();
  const captures = [];
  const writes = [];
  for (const id of ['first', 'second']) {
    await repository.put('takes', { id, sessionId: 'audio', status: 'recording', frames: 0, chunks: 0, bytes: 0 });
    const queue = new CommitQueue(repository, id);
    const graph = await engine.startTake(destination.stream);
    let sequence = 0, frames = 0, preparedResolve, startedResolve, stopResolve;
    const prepared = new Promise((resolve) => { preparedResolve = resolve; });
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const stopped = new Promise((resolve) => { stopResolve = resolve; });
    graph.recorder.port.onmessage = ({ data }) => {
      if (data.type === 'prepared') preparedResolve();
      if (data.type === 'started') startedResolve(data);
      if (data.type === 'audio') {
        if (data.startFrame !== frames) throw new Error('discontinuous audio');
        const wav = createPcm24Wav(data.samples);
        const chunk = { takeId: id, sequence: sequence++, startFrame: frames, frames: data.samples.length, byteLength: wav.size, wav };
        frames += data.samples.length;
        writes.push(queue.enqueue(chunk));
      }
      if (data.type === 'limit-reached') graph.recorder.port.postMessage({ type: 'stop' });
      if (data.type === 'stopped') stopResolve(data);
    };
    graph.recorder.port.postMessage({ type: 'prepare' });
    await prepared;
    graph.recorder.port.postMessage({ type: 'start', startAt: context.currentTime + 0.05, maximumFrames: 96000 });
    const start = await started;
    const stop = await stopped;
    if (stop.frames !== 96000 || stop.missingInputFrames || stop.contextGapFrames) throw new Error('unexpected capture duration or gap');
    await queue.patch({ status: 'stopped', startObservation: start });
    await queue.drain();
    queueMetrics.push(queue.metrics);
    captures.push({ frames: stop.frames, spanFrames: Math.round((stop.endSampleContextTime - start.contextTime) * 48000) });
    engine.stopGraph();
    await engine.startPreview(destination.stream);
  }
  await Promise.all(writes);
  const takes = await repository.listSessionTakes('audio');
  const exports = [];
  for (const take of takes) {
    const chunks = await repository.getTakeChunks(take.id);
    const parts = [];
    await writePcm24Wav(take, chunks, { async write(part) { parts.push(part); } });
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let peak = 0;
    for (let offset = 44; offset < bytes.length; offset += 3) {
      let sample = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
      if (sample & 0x800000) sample -= 0x1000000;
      peak = Math.max(peak, Math.abs(sample / 8388608));
    }
    if (peak < 0.2 || peak > 0.3) throw new Error(`unexpected PCM signal ${peak}`);
    exports.push({ frames: take.frames, chunks: chunks.length, bytes: bytes.length, peak });
  }
  await context.suspend();
  await engine.prime().resume;
  signal.stop(); signal.disconnect(); gain.disconnect();
  await engine.dispose();
  db.close();
  return { contexts: contexts.length, rate: context.sampleRate, closed: context.state, states, captures, exports, queueMetrics };
}

async function repositoryScenario() {
  const { DB_VERSION, openDatabase, RecordingRepository, transactionComplete } = await import('/prototype/recording-repository.js');
  const { CommitQueue, publishRecordingCommit } = await import('/prototype/recording-commit-queue.js');
  const { createPcm24Wav, writePcm24Wav } = await import('/prototype/wav-export.js');
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks += 1; };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
  const rejects = async (operation, pattern) => {
    let failure;
    try { await operation(); } catch (error) { failure = error; }
    check(failure && pattern.test(`${failure.name}: ${failure.message}`), `expected rejection ${pattern}, got ${failure}`);
    return failure;
  };
  const name = 'recording-repository-browser-test';
  const db = await openDatabase({ open: (...args) => indexedDB.open(...args) }, name);
  const repository = new RecordingRepository(db);
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1]);
  const wav = createPcm24Wav(samples);
  const chunk = (takeId, sequence = 0) => ({ takeId, sequence, startFrame: sequence * samples.length,
    frames: samples.length, byteLength: wav.size, wav });
  const seed = (id, status = 'recording') => repository.put('takes', {
    id, sessionId: 'repository', startedAt: 1, status, frames: 0, chunks: 0, bytes: 0, hostStoredChunks: []
  });
  const schema = (database) => {
    const transaction = database.transaction([...database.objectStoreNames], 'readonly');
    return [...database.objectStoreNames].map((name) => {
      const store = transaction.objectStore(name);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((name) => {
          const index = store.index(name);
          return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }) };
    });
  };
  const index = (name) => ({ name, keyPath: name, unique: false, multiEntry: false });
  const expectedSchema = [
    { name: 'chunks', keyPath: ['takeId', 'sequence'], autoIncrement: false, indexes: [index('takeId'), index('transferGeneration')] },
    { name: 'sessions', keyPath: 'id', autoIncrement: false, indexes: [] },
    { name: 'takes', keyPath: 'id', autoIncrement: false, indexes: [index('sessionId'), index('transferGeneration')] }
  ];
  try {
    equal(DB_VERSION, 3, 'public DB version changed');
    equal(db.version, 3, 'actual DB version changed');
    equal(schema(db), expectedSchema, 'stores or indexes changed');
    await seed('success');
    const metrics = [];
    const queue = new CommitQueue({ async commitChunk(input) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return repository.commitChunk(input);
    }, patchTake: (...args) => repository.patchTake(...args) }, 'success', {
      onMetrics(value) { metrics.push(value); throw new Error('metrics UI failed'); }
    });
    const tasks = [0, 1, 2].map((sequence) => queue.enqueue(chunk('success', sequence)));
    const pending = queue.metrics;
    equal([pending.pendingChunks, pending.pendingFrames, pending.pendingBytes], [3, 15, wav.size * 3], 'pending metrics wrong');
    const startObservation = { frame: 17, localPerfMs: 42, contextTime: 1 };
    const synchronization = { eventId: 'browser-sync', offsetMs: 2 };
    await repository.patchTake('success', { startObservation, synchronization, captureStatus: 'started' });
    const results = await Promise.all(tasks);
    await queue.patch({ status: 'stopped', endedAt: 123 });
    await queue.drain();
    const take = await repository.read('takes', 'get', 'success');
    equal([take.frames, take.chunks, take.bytes], [15, 3, wav.size * 3], 'atomic counters wrong');
    equal([take.startObservation, take.synchronization, take.status],
      [startObservation, synchronization, 'stopped'], 'metadata lost at commit/completion');
    await seed('ack');
    await repository.commitChunk(chunk('ack'));
    const ackQueue = new CommitQueue(repository, 'ack');
    const hash = 'a'.repeat(64);
    const ackResults = await Promise.all([
      ackQueue.enqueue(chunk('ack', 1)),
      repository.markTransferChunkStored('ack', 0, hash),
      repository.patchTake('ack', { startObservation, synchronization })
    ]);
    await ackQueue.patch({ status: 'stopped' });
    await ackQueue.drain();
    const acknowledged = await repository.read('takes', 'get', 'ack');
    equal([acknowledged.frames, acknowledged.chunks, acknowledged.bytes, acknowledged.startObservation,
      acknowledged.synchronization, acknowledged.status], [10, 2, wav.size * 2, startObservation, synchronization, 'stopped'], 'parallel ACK lost counters or metadata');
    equal(acknowledged.hostStoredChunks, [{ sequence: 0, sha256: hash, bytes: wav.size, frames: 5 }], 'parallel ACK ledger lost');
    equal(ackResults[1].sequence, 0, 'ACK did not return confirmed chunk');
    equal((await repository.getTakeChunks('ack')).map((item) => item.sequence), [1], 'ACK did not atomically delete chunk');
    equal(await repository.markTransferChunkStored('ack', 0, hash), null, 'duplicate ACK not idempotent');
    await rejects(() => repository.markTransferChunkStored('ack', 0, 'b'.repeat(64)), /abort/i);
    equal(await repository.read('takes', 'get', 'ack'), acknowledged, 'conflicting ACK changed ledger');
    await Promise.all([
      ackQueue.patch({ status: 'stopped', endedAt: 456 }),
      repository.markTransferChunkStored('ack', 1, hash),
      repository.patchTake('ack', { startObservation, synchronization })
    ]);
    await ackQueue.drain();
    const completedAck = await repository.read('takes', 'get', 'ack');
    equal([completedAck.hostStoredChunks.length, completedAck.frames, completedAck.chunks, completedAck.bytes,
      completedAck.status, completedAck.endedAt, completedAck.startObservation, completedAck.synchronization],
      [2, 10, 2, wav.size * 2, 'stopped', 456, startObservation, synchronization], 'ACK lost during completion');
    equal(await repository.getTakeChunks('ack'), [], 'completion ACK chunk retained');
    const chunks = await repository.getTakeChunks('success');
    equal(chunks.map((item) => [item.sequence, item.startFrame, item.frames]), [[0, 0, 5], [1, 5, 5], [2, 10, 5]], 'saved chunks wrong');
    equal(results.map((result) => result.take.frames), [5, 10, 15], 'queue ordering wrong');
    check(metrics.length > 0 && metrics.every((item) => Number.isFinite(item.transactionMs) && item.transactionMs >= 0), 'transaction timings invalid');
    const drained = queue.metrics;
    equal([drained.pendingChunks, drained.pendingFrames, drained.pendingBytes, drained.oldestWaitMs], [0, 0, 0, 0], 'queue did not drain');
    check(drained.maxOldestWaitMs >= 20 && drained.maxPendingFrames === 15 && drained.maxPendingBytes === wav.size * 3, 'queue maxima missing');
    const failures = await publishRecordingCommit(results.at(-1), {
      update() { throw new Error('display failed'); }, async notify() { throw new Error('notify failed'); },
      onError() { throw new Error('error UI failed'); }
    });
    equal(failures.map((failure) => failure.stage), ['display', 'notification'], 'publish failures not isolated');
    equal(await repository.read('takes', 'get', 'success'), take, 'publish changed storage');
    const parts = [];
    await writePcm24Wav(take, chunks, { async write(part) { parts.push(part); } });
    const output = new Uint8Array(await new Blob(parts).arrayBuffer());
    const expected = new Uint8Array(await createPcm24Wav(new Float32Array([...samples, ...samples, ...samples])).arrayBuffer());
    equal([...output], [...expected], 'WAV header/payload round trip differs');
    await rejects(() => writePcm24Wav(take, chunks.slice(1), { async write() {} }), /ledger|frame count/);
    await rejects(() => writePcm24Wav(take, [chunks[0], { ...chunks[1], startFrame: 6 }, chunks[2]], { async write() {} }), /ledger/);
    await rejects(() => writePcm24Wav(take, [chunks[0], chunks[0], chunks[2]], { async write() {} }), /ledger/);
    await rejects(() => repository.commitChunk(chunk('missing')), /saved ledger/);
    await rejects(() => repository.commitChunk(chunk('success', 0)), /saved ledger/);
    await rejects(() => repository.commitChunk({ ...chunk('success', 3), startFrame: 16 }), /saved ledger/);
    equal(await repository.read('takes', 'get', 'success'), take, 'rejected commit mutated ledger');
    equal((await repository.getTakeChunks('success')).length, 3, 'rejected commit mutated chunks');
    await seed('duplicate-key', 'stopped');
    await repository.put('chunks', chunk('duplicate-key'));
    const duplicateBefore = await repository.read('takes', 'get', 'duplicate-key');
    await rejects(() => repository.commitChunk(chunk('duplicate-key')), /ConstraintError/);
    equal(await repository.read('takes', 'get', 'duplicate-key'), duplicateBefore, 'duplicate key request did not roll back take write');
    equal((await repository.getTakeChunks('duplicate-key')).length, 1, 'duplicate key changed stored chunk');
    const rollbacks = [];
    for (const mode of ['chunk-success-before-take', 'take-success-before-chunk', 'quota']) {
      await seed(mode);
      const before = await repository.read('takes', 'get', mode);
      const nativeTransaction = db.transaction;
      let succeeded = null, transactionStarted = false;
      db.transaction = function(stores, access, ...args) {
        const transaction = nativeTransaction.call(this, stores, access, ...args);
        if (access !== 'readwrite' || !Array.isArray(stores) || !stores.includes('chunks')) return transaction;
        transactionStarted = true;
        const nativeObjectStore = transaction.objectStore.bind(transaction);
        const takes = nativeObjectStore('takes'), chunks = nativeObjectStore('chunks');
        const nativePut = takes.put.bind(takes), nativeAdd = chunks.add.bind(chunks);
        let deferredChunk;
        if (mode === 'take-success-before-chunk') {
          chunks.add = (input) => { deferredChunk = input; };
          takes.put = (input) => {
            const request = nativePut(input);
            request.addEventListener('success', () => {
              succeeded = 'takes';
              check(!!deferredChunk, 'chunk failure was not deferred');
              transaction.abort();
            }, { once: true });
            return request;
          };
        } else if (mode === 'chunk-success-before-take') {
          chunks.add = (input) => {
            const request = nativeAdd(input);
            request.addEventListener('success', () => { succeeded = 'chunks'; transaction.abort(); }, { once: true });
            return request;
          };
          takes.put = () => {};
        } else {
          takes.put = () => { throw new DOMException('Injected quota failure (no disk exhaustion)', 'QuotaExceededError'); };
        }
        transaction.objectStore = (name) => name === 'takes' ? takes : name === 'chunks' ? chunks : nativeObjectStore(name);
        return transaction;
      };
      const failedQueue = new CommitQueue(repository, mode);
      let error;
      try {
        error = await rejects(() => failedQueue.enqueue(chunk(mode)), mode === 'quota' ? /QuotaExceededError/ : /abort/i);
        await rejects(() => failedQueue.drain(), mode === 'quota' ? /QuotaExceededError/ : /abort/i);
      } finally { db.transaction = nativeTransaction; }
      check(transactionStarted, 'failure did not use a real IndexedDB transaction');
      equal(succeeded, mode === 'quota' ? null : mode.startsWith('chunk') ? 'chunks' : 'takes', 'first write did not succeed before abort');
      equal(await repository.read('takes', 'get', mode), before, 'aborted take counters persisted');
      equal(await repository.getTakeChunks(mode), [], 'aborted chunk persisted');
      equal(failedQueue.metrics.pendingChunks, 0, 'failed queue did not drain');
      check(Number.isFinite(error.transactionMs) && error.transactionMs >= 0, 'failure transaction timing missing');
      rollbacks.push({ mode, succeeded, error: error.name, transactionMs: error.transactionMs });
    }
    await seed('interrupted');
    await repository.commitChunk(chunk('interrupted'));
    await seed('preparing', 'preparing');
    await seed('canceled', 'preparing');
    await repository.deleteUnstartedTake('canceled');
    equal(await repository.read('takes', 'get', 'canceled'), undefined, 'preparing cancellation persisted');
    equal(await repository.recoverInterruptedTakes(), 4, 'recovery count wrong');
    equal(await repository.read('takes', 'get', 'preparing'), undefined, 'recovery retained preparing take');
    const recovered = await repository.read('takes', 'get', 'interrupted');
    equal([recovered.status, recovered.frames, recovered.chunks, recovered.bytes, recovered.tailUnknown],
      ['recovered', 5, 1, wav.size, true], 'recovery counters or unknown tail wrong');
    equal((await repository.getTakeChunks('interrupted')).length, 1, 'recovery lost confirmed chunk');
    equal(await repository.recoverInterruptedTakes(), 0, 'recovery not idempotent');
    equal(await repository.read('takes', 'get', 'success'), take, 'recovery modified stopped take');
    equal(schema(db), expectedSchema, 'scenario modified stores/indexes');
    const reopened = await openDatabase(indexedDB, name);
    equal(schema(reopened), expectedSchema, 'reopen modified schema');
    equal(await new RecordingRepository(reopened).read('takes', 'get', 'success'), take, 'commits not persistent across reopen');
    reopened.close();
    // Ensure all schema-read transactions complete before closing the connection.
    await transactionComplete(db.transaction('takes', 'readonly'));
    return { checks, version: db.version, commits: results.length, metricSamples: metrics.length,
      metrics: drained, rollbacks, wavBytes: output.length };
  } finally { db.close(); }
}

async function recorderScenario() {
  const waitFor = async (predicate) => {
    const until = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > until) throw new Error(`UI timeout: ${document.getElementById('errorText')?.textContent}; status=${document.getElementById('statusMessage')?.textContent}; log=${document.getElementById('networkEventLog')?.textContent}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor(() => document.getElementById('micDevice')?.options.length > 0);
  await waitFor(() => document.getElementById('logoutButton') && !document.getElementById('logoutButton').hidden);
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.getElementById('participantName').value = 'Browser test';
  await waitFor(() => document.getElementById('participantName').value !== '' && document.getElementById('micDevice').value !== '');
  document.getElementById('networkEventLog').textContent = 'previous studio marker';
  document.getElementById('networkEventPanel').open = false;
  document.getElementById('setupForm').requestSubmit();
  await waitFor(() => !document.getElementById('studioView').hidden);
  const panel = document.getElementById('networkEventPanel');
  const titleStyle = getComputedStyle(panel.querySelector('.terminal-section-code'));
  if (titleStyle.marginBottom !== '0px') throw new Error('event heading margin misaligns disclosure arrow');
  if (getComputedStyle(panel.querySelector('summary'), '::before').content !== '""') throw new Error('arrow depends on font baseline');
  if (!panel.open || document.getElementById('networkEventLog').textContent.includes('previous studio marker')) throw new Error('studio log was not reset');
  panel.querySelector('summary').click();
  if (panel.open) throw new Error('event panel did not collapse');
  panel.querySelector('summary').click();
  if (!panel.open) throw new Error('event panel did not expand');
  await waitFor(() => !document.getElementById('recordButton').disabled);
  document.getElementById('recordButton').click();
  document.getElementById('stopButton').click();
  await waitFor(() => !document.getElementById('recordButton').disabled);
  if (document.getElementById('captureStatusBadge').classList.contains('on')) throw new Error('canceled preparation went on air');
  for (let index = 0; index < 2; index += 1) {
    await waitFor(() => !document.getElementById('recordButton').disabled);
    document.getElementById('recordButton').click();
    await waitFor(() => document.getElementById('captureStatusBadge').classList.contains('on'));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    document.getElementById('stopButton').click();
    await waitFor(() => !document.getElementById('recordButton').disabled);
  }
  const request = indexedDB.open('perfectpodcast-local-v1');
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const transaction = db.transaction(['takes', 'chunks'], 'readonly');
  const takes = transaction.objectStore('takes').getAll();
  const chunks = transaction.objectStore('chunks').getAll();
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
  for (const take of takes.result) {
    const saved = chunks.result.filter((chunk) => chunk.takeId === take.id).sort((a, b) => a.sequence - b.sequence);
    if (take.status !== 'stopped' || take.frames < 48000 || !take.startObservation) throw new Error('invalid saved UI take');
    let frames = 0;
    for (let index = 0; index < saved.length; index += 1) {
      const chunk = saved[index];
      if (chunk.sequence !== index || chunk.startFrame !== frames) throw new Error('UI chunk discontinuity');
      frames += chunk.frames;
    }
    if (frames !== take.frames) throw new Error('UI saved frame mismatch');
  }
  const logs = document.getElementById('networkEventLog').textContent;
  const contextEvents = (logs.match(/shared local context/g) || []).length;
  const failureStatuses = [];
  for (const failure of ['timeout', 'completion']) {
    document.getElementById('recordButton').click();
    await waitFor(() => document.getElementById('captureStatusBadge').classList.contains('on'));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    window.dropRecordingStop = failure === 'timeout';
    window.failRecordingCompletion = failure === 'completion';
    document.getElementById('stopButton').click();
    document.getElementById('stopButton').click();
    await waitFor(() => !document.getElementById('recordButton').disabled);
    window.dropRecordingStop = false;
    const readFailure = db.transaction('takes', 'readonly');
    const failedTakes = readFailure.objectStore('takes').getAll();
    await new Promise((resolve, reject) => { readFailure.oncomplete = resolve; readFailure.onabort = () => reject(readFailure.error); });
    const last = failedTakes.result.sort((a, b) => a.startedAt - b.startedAt).at(-1);
    const expected = failure === 'timeout' ? 'recovered' : 'recording';
    if (last.status !== expected) throw new Error(`failure falsely certified: ${failure} ${last.status}`);
    if (failure === 'timeout' && !last.tailUnknown) throw new Error('unknown tail not marked');
    if (!document.getElementById('errorText').textContent) throw new Error('failure not displayed');
    failureStatuses.push(last.status);
  }
  if (window.audioContextCounts.created !== 1 || window.audioContextCounts.closed !== 0) throw new Error('UI context was recreated between takes');
  document.getElementById('backButton').click();
  await waitFor(() => document.getElementById('studioView').hidden);
  await waitFor(() => window.audioContextCounts.closed === 1);
  db.close();
  return { takes: takes.result.length, contextEvents, failureStatuses, counts: window.audioContextCounts, frames: takes.result.map((take) => take.frames) };
}

for (const [name, executable] of Object.entries(browserPaths)) {
  test(`${name}: real Worklet, shared context, IndexedDB and PCM WAV round trip`, {
    skip: process.env.AUDIO_BROWSER_TESTS !== '1', timeout: 45000
  }, async () => {
    const profile = await mkdtemp(join(resolve('.'), '.audio-browser-profile-'));
    const root = resolve('.');
    const server = createServer(async (request, response) => {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Audio test</title>'); return; }
      if (request.url === '/test-host-session') {
        if (process.env.AUDIO_DELAY_HOST === '1') await new Promise((resolve) => setTimeout(resolve, 250));
        response.setHeader('Content-Type', 'application/json');
        response.end('{"sub":"test"}');
        return;
      }
      if (request.url === '/prototype/auth-client.bundle.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('export async function getHostSession(){return (await fetch("/test-host-session")).json()}; export async function getHostDisplayName(){return "Test"}; export async function getAuth0Client(){return {}}; export async function signOut(){};');
        return;
      }
      const path = resolve(root, `.${request.url}`);
      if (!path.startsWith(`${root}/prototype/`)) { response.writeHead(404).end(); return; }
      try { response.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.html' ? 'text/html' : extname(path) === '.css' ? 'text/css' : 'text/plain'); response.end(await readFile(path)); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', origin], { stdio: ['ignore', 'ignore', 'pipe'] });
    let socket;
    try {
      const websocketBase = await new Promise((resolve, reject) => {
        let output = '';
        browser.stderr.on('data', (bytes) => { output += bytes; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
        browser.on('error', reject);
        browser.on('exit', (code) => reject(new Error(`browser exited ${code}`)));
      });
      const port = new URL(websocketBase).port;
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((page) => page.type === 'page');
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const pending = new Map(); let id = 0;
      socket.onmessage = ({ data }) => { const message = JSON.parse(data); const handlers = pending.get(message.id); if (handlers) { pending.delete(message.id); message.error ? handlers.reject(new Error(JSON.stringify(message.error))) : handlers.resolve(message.result); } };
      const command = (method, params) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
      const initialDeadline = Date.now() + 10000;
      while (true) {
        const ready = await command('Runtime.evaluate', {
          expression: `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`, returnByValue: true
        });
        if (ready.result.value === true) break;
        if (Date.now() > initialDeadline) throw new Error('Initial browser navigation timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const repositoryResult = await command('Runtime.evaluate', {
        expression: `(${repositoryScenario.toString()})()`, awaitPromise: true, returnByValue: true
      });
      assert.equal(repositoryResult.exceptionDetails, undefined, JSON.stringify(repositoryResult.exceptionDetails));
      assert.ok(repositoryResult.result.value.checks >= 60);
      assert.equal(repositoryResult.result.value.commits, 3);
      assert.equal(repositoryResult.result.value.rollbacks.length, 3);
      console.log(`${name} repository verification: ${JSON.stringify(repositoryResult.result.value)}`);
      const result = await command('Runtime.evaluate', { expression: `(${browserScenario.toString()})()`, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      const value = result.result.value;
      assert.equal(value.contexts, 1);
      assert.equal(value.rate, 48000);
      assert.equal(value.closed, 'closed');
      assert.ok(value.states.includes('suspended'));
      assert.deepEqual(value.captures.map((capture) => capture.frames), [96000, 96000]);
      assert.deepEqual(value.captures.map((capture) => capture.spanFrames), [96000, 96000]);
      for (const output of value.exports) { assert.equal(output.chunks, 2); assert.equal(output.bytes, 288044); }
      console.log(`${name} audio verification: ${JSON.stringify(value)}`);
      await command('Page.enable', {});
      await command('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.audioContextCounts = { created: 0, closed: 0 };
        const postMessage = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...args) {
          if (window.dropRecordingStop && message?.type === 'stop') return;
          return postMessage.call(this, message, ...args);
        };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
          const result = transaction.call(this, stores, mode, ...args);
          if (window.failRecordingCompletion && stores === 'takes' && mode === 'readwrite') {
            window.failRecordingCompletion = false;
            queueMicrotask(() => result.abort());
          }
          return result;
        };
        const NativeAudioContext = window.AudioContext;
        window.AudioContext = class extends NativeAudioContext {
          constructor(options) { super(options); window.audioContextCounts.created += 1; }
          close() { window.audioContextCounts.closed += 1; return super.close(); }
        };
      ` });
      await command('Page.navigate', { url: `${origin}/prototype/recorder.html` });
      const navigationDeadline = Date.now() + 10000;
      while (true) {
        const ready = await command('Runtime.evaluate', {
          expression: 'location.pathname === "/prototype/recorder.html" && document.readyState === "complete"', returnByValue: true
        }).catch(() => null);
        if (ready?.result.value === true) break;
        if (Date.now() > navigationDeadline) throw new Error('Recorder navigation timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const uiResult = await command('Runtime.evaluate', {
        expression: `(${recorderScenario.toString()})()`, awaitPromise: true, returnByValue: true
      });
      assert.equal(uiResult.exceptionDetails, undefined, JSON.stringify(uiResult.exceptionDetails));
      assert.equal(uiResult.result.value.takes, 2);
      assert.equal(uiResult.result.value.contextEvents, 3);
      console.log(`${name} recorder page verification: ${JSON.stringify(uiResult.result.value)}`);
    } finally {
      socket?.close();
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      if (browser.exitCode === null) { browser.kill(); await exited; }
      await new Promise((resolve) => server.close(resolve));
      await rm(profile, { recursive: true, force: true });
    }
  });
}
