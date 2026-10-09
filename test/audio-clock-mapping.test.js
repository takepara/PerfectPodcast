import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const mapping = source.slice(source.indexOf('function audioContextTimeAtPerformanceTime('), source.indexOf('\nfunction primeRecordingAudioContext'));

test('zero output performance timestamp cannot postpone capture by the page uptime', () => {
  const events = [];
  const context = vm.createContext({
    audioContext: { state: 'running', currentTime: 26.843,
      getOutputTimestamp: () => ({ performanceTime: 0, contextTime: 26.837 }) },
    performance: { now: () => 29418.7 }, appendNetworkEvent: (...args) => events.push(args)
  });
  vm.runInContext(mapping, context);
  const target = context.audioContextTimeAtPerformanceTime(29919.2);
  assert.ok(Math.abs(target - 27.3435) < 0.000001);
  assert.match(events[0][1], /mapping=currentTime/);
});

test('start scheduling ignores even valid output timestamps and uses a nearby currentTime anchor', () => {
  const context = vm.createContext({
    audioContext: { state: 'running', currentTime: 10,
      getOutputTimestamp() { assert.fail('output clock must not be used for input scheduling'); } },
    performance: { now: () => 20000 }, appendNetworkEvent() {}
  });
  vm.runInContext(mapping, context);
  assert.equal(context.audioContextTimeAtPerformanceTime(20500), 10.5);
});


test('fallback schedule actually starts the Worklet after half a second and captures subsequent audio', () => {
  let Processor;
  const context = { currentTime: 26.843, sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); } }; } },
    registerProcessor: (_name, processor) => { Processor = processor; }
  };
  vm.runInNewContext(readFileSync(new URL('../prototype/recorder-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'start', startAt: 27.3435, maximumFrames: 96000 } });
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  assert.equal(processor.totalFrames, 0);
  context.currentTime = 27.35;
  processor.process([[new Float32Array(48000)]], [[new Float32Array(48000)]]);
  assert.equal(processor.port.messages.filter((message) => message.type === 'started').length, 1);
  assert.equal(processor.totalFrames, 48000);
  assert.equal(processor.port.messages.find((message) => message.type === 'audio').samples.length, 48000);
});
