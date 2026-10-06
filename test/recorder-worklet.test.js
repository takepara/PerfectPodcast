import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadProcessor() {
  const source = await readFile(new URL('../prototype/recorder-worklet.js', import.meta.url), 'utf8');
  let Processor;
  const context = {
    currentTime: 0,
    sampleRate: 48_000,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          messages: [],
          postMessage(message) {
            this.messages.push(message);
          }
        };
      }
    },
    Float32Array,
    Number,
    registerProcessor(_name, processor) {
      Processor = processor;
    }
  };
  vm.runInNewContext(source, context);
  return { processor: new Processor(), context };
}

test('AudioWorklet stops exactly at the configured session frame limit', async () => {
  const { processor } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 10 } });
  processor.process([[new Float32Array(15).fill(0.25)]], [[new Float32Array(15)]]);

  const audio = processor.port.messages.filter((message) => message.type === 'audio');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].samples.length, 10);
  assert.equal(audio[0].startFrame, 0);
  assert.equal(audio[0].final, true);
  assert.deepEqual(
    processor.port.messages.filter((message) => message.type === 'limit-reached').length,
    1
  );

  processor.process([[new Float32Array(15).fill(0.5)]], [[new Float32Array(15)]]);
  assert.equal(processor.port.messages.filter((message) => message.type === 'audio').length, 1);
});

test('marks the final full WAV chunk as final when the frame limit aligns to one second', async () => {
  const { processor } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 48_000 } });
  processor.process([[new Float32Array(48_000)]], [[new Float32Array(48_000)]]);

  const audio = processor.port.messages.filter((message) => message.type === 'audio');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].samples.length, 48_000);
  assert.equal(audio[0].final, true);
  assert.equal(processor.port.messages.filter((message) => message.type === 'limit-reached').length, 1);
});

test('waits for the scheduled AudioContext time before recording frames', async () => {
  const { processor, context } = await loadProcessor();
  const event = { eventId: 'start-event', sequence: 3 };
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 10, startAt: 1, ...event } });
  processor.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  assert.equal(processor.port.messages.some((message) => message.type === 'audio'), false);

  context.currentTime = 1;
  processor.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  const started = processor.port.messages.find((message) => message.type === 'started');
  assert.equal(started.frame, 0);
  assert.equal(started.contextTime, 1);
  assert.equal(started.event.eventId, event.eventId);
  assert.equal(started.event.sequence, event.sequence);
  assert.equal(processor.port.messages.filter((message) => message.type === 'audio').length, 1);
});
