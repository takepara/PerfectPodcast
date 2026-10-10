import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { LocalAudioEngine } from '../prototype/local-audio-engine.js';
import { createPcm24Wav, writePcm24Wav } from '../prototype/wav-export.js';

test('public engine graph forwards scheduled PCM into complete sequential WAV payloads', async () => {
  let Processor;
  const clock = { currentTime: 0, sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage(data) { this.deliver?.({ data }); } }; } },
    registerProcessor(_name, processor) { Processor = processor; } };
  vm.runInNewContext(readFileSync(new URL('../prototype/recorder-worklet.js', import.meta.url), 'utf8'), clock);
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  const context = { sampleRate: 48000, state: 'running', audioWorklet: { async addModule() {} },
    addEventListener() {}, removeEventListener() {}, async close() { this.state = 'closed'; },
    createMediaStreamSource: node, createChannelSplitter: node, createAnalyser() { return { ...node(), fftSize: 2048 }; } };
  let processor;
  const engine = new LocalAudioEngine({ createContext: () => context,
    createWorklet() { processor = new Processor(); const worklet = { ...node(), port: { onmessage: null } };
      processor.port.deliver = (event) => worklet.port.onmessage?.(event); return worklet; } });
  const stream = { getAudioTracks: () => [{ readyState: 'live' }], getTracks: () => [] };
  await engine.startPreview(stream);
  const graph = await engine.startTake(stream);
  const chunks = [];
  graph.recorder.port.onmessage = ({ data }) => {
    if (data.type !== 'audio') return;
    const wav = createPcm24Wav(data.samples);
    chunks.push({ sequence: chunks.length, startFrame: data.startFrame, frames: data.samples.length, wav, byteLength: wav.size });
  };
  processor.port.onmessage({ data: { type: 'start', startAt: 128 / 48000, maximumFrames: 96000 } });
  for (let frame = 0; frame < 96128; frame += 128) {
    clock.currentTime = frame / 48000;
    processor.process([[new Float32Array(128).fill(0.25)]], []);
  }
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.startFrame), [0, 48000]);
  const parts = [];
  await writePcm24Wav({ frames: 96000 }, chunks, { async write(part) { parts.push(part); } });
  const output = new Uint8Array(await new Blob(parts).arrayBuffer());
  assert.equal(output.length, 288044);
  for (let offset = 44; offset < output.length; offset += 3) {
    assert.deepEqual([...output.subarray(offset, offset + 3)], [0, 0, 32]);
  }
  await engine.dispose();
});
