import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAudioEngine } from '../prototype/local-audio-engine.js';

function setup({ rate = 48000, moduleFailure = false, delayedModule = false } = {}) {
  const contexts = [], nodes = [], states = [];
  let resolveModule;
  const moduleReady = delayedModule ? new Promise((resolve) => { resolveModule = resolve; }) : Promise.resolve();
  const node = (kind) => {
    const value = { kind, connections: [], disconnected: false,
      connect(destination, ...ports) { this.connections.push([destination, ...ports]); return destination; },
      disconnect() { this.disconnected = true; } };
    nodes.push(value);
    return value;
  };
  const engine = new LocalAudioEngine({
    createContext(options) {
      assert.equal(options.sampleRate, 48000);
      const listeners = new Map();
      const context = { sampleRate: rate, state: 'suspended', closes: 0, modules: 0,
        audioWorklet: { async addModule() { context.modules += 1; await moduleReady; if (moduleFailure) throw new Error('module failed'); } },
        async resume() { this.state = 'running'; listeners.get('statechange')?.(); },
        async close() { this.closes += 1; this.state = 'closed'; listeners.get('statechange')?.(); },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        changeState(state) { this.state = state; listeners.get('statechange')?.(); },
        createMediaStreamSource(stream) { const source = node('source'); source.stream = stream; return source; },
        createChannelSplitter() { return node('splitter'); },
        createAnalyser() { return node('analyser'); }
      };
      contexts.push(context);
      return context;
    },
    createWorklet(context, name, options) {
      assert.equal(context, contexts.at(-1));
      assert.equal(name, 'perfectpodcast-local-recorder');
      assert.equal(options.numberOfOutputs, 0);
      const worklet = node('worklet'); worklet.port = { onmessage: null }; return worklet;
    },
    onStateChange: (state) => states.push(state)
  });
  const makeStream = () => {
    const track = { readyState: 'live', stopped: 0, stop() { this.stopped += 1; this.readyState = 'ended'; } };
    return { track, getTracks: () => [track], getAudioTracks: () => [track] };
  };
  return { engine, contexts, nodes, states, makeStream, resolveModule };
}

test('preview, readiness, takes and resume share one 48 kHz context', async () => {
  const { engine, contexts, makeStream } = setup();
  const stream = makeStream();
  const first = await engine.startPreview(stream);
  await engine.checkReadiness(stream);
  const take = await engine.startTake(stream);
  assert.equal(first.context, take.context);
  assert.equal(first.recorder.disconnected, true);
  assert.notEqual(first.recorder, take.recorder);
  engine.stopGraph();
  assert.equal(take.recorder.port.onmessage, null);
  const preview = await engine.startPreview(stream);
  const secondTake = await engine.startTake(stream);
  assert.notEqual(secondTake.recorder, take.recorder);
  assert.equal(preview.context, secondTake.context);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].modules, 1);
  assert.equal(contexts[0].closes, 0);
  assert.equal(stream.track.stopped, 0);
  assert.deepEqual(secondTake.source.connections[0], [secondTake.input]);
  assert.deepEqual(secondTake.input.connections[0], [secondTake.analyser, 0, 0]);
  assert.equal(secondTake.analyser.connections[0][0], secondTake.recorder);
  assert.equal(secondTake.recorder.connections.length, 0);
});

test('prime resumes synchronously before asynchronous checks, with no oscillator or output', async () => {
  const { engine, contexts } = setup();
  const prepared = engine.prime();
  assert.equal(contexts[0].state, 'running');
  assert.equal(await prepared.resume, null);
  assert.equal(engine.prime().context, prepared.context);
});

test('rejects an actual non-48 kHz context instead of reusing it', async () => {
  const { engine, contexts, makeStream } = setup({ rate: 44100 });
  await assert.rejects(engine.startPreview(makeStream()), /48,000/);
  assert.equal(contexts[0].closes, 1);
  assert.equal(engine.context, null);
});

test('module preparation failure disconnects no live input and can be retried', async () => {
  const { engine, contexts, makeStream } = setup({ moduleFailure: true });
  const stream = makeStream();
  await assert.rejects(engine.startPreview(stream), /module failed/);
  assert.equal(engine.graph, null);
  assert.equal(contexts[0].closes, 0);
  assert.equal(stream.track.stopped, 0);
  await assert.rejects(engine.startPreview(stream), /module failed/);
  assert.equal(contexts[0].modules, 2);
  await engine.dispose();
  assert.equal(stream.track.stopped, 1);
});

test('changing input keeps the context and stops the old track only after graph replacement', async () => {
  const { engine, contexts, makeStream } = setup();
  const original = makeStream(), replacement = makeStream();
  const preview = await engine.startPreview(original);
  await engine.startPreview(replacement);
  assert.equal(preview.source.disconnected, true);
  assert.equal(original.track.stopped, 1);
  assert.equal(replacement.track.stopped, 0);
  assert.equal(contexts.length, 1);
  await engine.dispose();
  await engine.dispose();
  assert.equal(replacement.track.stopped, 1);
  assert.equal(contexts[0].closes, 1);
});

test('failed graph replacement preserves the original input and context', async () => {
  const { engine, contexts, makeStream } = setup();
  const original = makeStream(), replacement = makeStream();
  const preview = await engine.startPreview(original);
  const createWorklet = engine.createWorklet;
  engine.createWorklet = () => { throw new Error('graph failed'); };
  await assert.rejects(engine.startPreview(replacement), /graph failed/);
  assert.equal(engine.graph, preview);
  assert.equal(preview.source.disconnected, false);
  assert.equal(original.track.stopped, 0);
  assert.equal(contexts.length, 1);
  engine.createWorklet = createWorklet;
  await engine.dispose();
  assert.equal(original.track.stopped, 1);
  assert.equal(replacement.track.stopped, 1);
});

test('ended input during module loading cannot be attached', async () => {
  const { engine, makeStream, resolveModule } = setup({ delayedModule: true });
  const stream = makeStream();
  const pending = engine.startPreview(stream);
  stream.track.stop();
  resolveModule();
  await assert.rejects(pending, /ended/);
  assert.equal(engine.graph, null);
  await engine.dispose();
  assert.equal(stream.track.stopped, 1);
});

test('exposes suspension and interruption without stopping tracks or inventing audio', async () => {
  const { engine, contexts, states, makeStream } = setup();
  const stream = makeStream();
  await engine.startPreview(stream);
  contexts[0].changeState('interrupted');
  contexts[0].changeState('suspended');
  await engine.prime().resume;
  assert.ok(states.includes('interrupted'));
  assert.ok(states.includes('suspended'));
  assert.equal(stream.track.stopped, 0);
});

test('dispose or canceled preparation cannot install a stale graph', async () => {
  const { engine, contexts, makeStream, resolveModule } = setup({ delayedModule: true });
  const stream = makeStream();
  const pending = engine.startPreview(stream);
  await engine.dispose();
  resolveModule();
  await assert.rejects(pending, /canceled/);
  assert.equal(engine.graph, null);
  assert.equal(engine.context, null);
  assert.equal(stream.track.stopped, 1);
  assert.equal(contexts[0].closes, 1);
});

test('a later take supersedes a delayed preview without losing its shared track', async () => {
  const { engine, makeStream, resolveModule } = setup({ delayedModule: true });
  const stream = makeStream();
  const preview = engine.startPreview(stream);
  const take = engine.startTake(stream);
  resolveModule();
  await assert.rejects(preview, /canceled/);
  const graph = await take;
  assert.equal(engine.graph, graph);
  assert.equal(stream.track.stopped, 0);
});
