import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

const browserPaths = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
};

async function browserScenario() {
  const { LocalAudioEngine } = await import('/prototype/local-audio-engine.js');
  const { createPcm24Wav, writePcm24Wav } = await import('/prototype/wav-export.js');
  const contexts = [];
  const states = [];
  const engine = new LocalAudioEngine({
    createContext(options) { const context = new AudioContext(options); contexts.push(context); return context; },
    onStateChange(state) { states.push(state); }
  });
  const request = indexedDB.open('local-audio-engine-test', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('chunks', { keyPath: ['takeId', 'sequence'] });
    request.result.createObjectStore('takes', { keyPath: 'id' });
  };
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const transactionDone = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
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
        const transaction = db.transaction(['chunks', 'takes'], 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore('chunks').put(chunk);
        transaction.objectStore('takes').put({ id, frames, chunks: sequence });
        writes.push(done);
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
    captures.push({ frames: stop.frames, spanFrames: Math.round((stop.endSampleContextTime - start.contextTime) * 48000) });
    engine.stopGraph();
    await engine.startPreview(destination.stream);
  }
  await Promise.all(writes);
  const read = db.transaction(['chunks', 'takes'], 'readonly');
  const done = transactionDone(read);
  const chunksRequest = read.objectStore('chunks').getAll();
  const takesRequest = read.objectStore('takes').getAll();
  await done;
  const aborted = db.transaction(['chunks', 'takes'], 'readwrite');
  const abortDone = transactionDone(aborted);
  aborted.objectStore('takes').put({ id: 'aborted', frames: 1 });
  aborted.objectStore('chunks').put({ takeId: 'aborted', sequence: 0 });
  aborted.abort();
  await abortDone.catch(() => {});
  const check = db.transaction(['takes', 'chunks'], 'readonly');
  const checkDone = transactionDone(check);
  const abortedTake = check.objectStore('takes').get('aborted');
  const abortedChunk = check.objectStore('chunks').get(['aborted', 0]);
  await checkDone;
  if (abortedTake.result || abortedChunk.result) throw new Error('partial transaction persisted');
  const exports = [];
  for (const take of takesRequest.result) {
    const chunks = chunksRequest.result.filter((chunk) => chunk.takeId === take.id);
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
  return { contexts: contexts.length, rate: context.sampleRate, closed: context.state, states, captures, exports };
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
    const profile = await mkdtemp(join(tmpdir(), 'perfectpodcast-audio-test-'));
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
