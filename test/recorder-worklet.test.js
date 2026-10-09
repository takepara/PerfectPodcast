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


test('immediate recording reports exactly one first-frame observation', async () => {
  const { processor } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000 } });
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  const starts = processor.port.messages.filter((message) => message.type === 'started');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].frame, 0);
  assert.equal(starts[0].contextTime, 0);
  assert.equal(processor.port.messages[0].type, 'armed');
});



test('records and flushes the original input with no audio outputs', async () => {
  const { processor, context } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000, startAt: 1 } });
  processor.process([[new Float32Array(128).fill(0.25)]], []);
  assert.equal(processor.totalFrames, 0);
  context.currentTime = 1;
  processor.process([[new Float32Array(128).fill(0.25)]], []);
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(processor.port.messages.filter((message) => message.type === 'started').length, 1);
  const audio = processor.port.messages.find((message) => message.type === 'audio');
  assert.equal(audio.samples.length, 128);
  assert.ok(audio.samples.every((sample) => sample === 0.25));
  assert.equal(audio.final, true);
  const stopped = processor.port.messages.at(-1);
  assert.equal(stopped.type, 'stopped');
  assert.equal(stopped.frames, 128);
  assert.equal(stopped.firstSampleContextTime, 1);
  assert.ok(Math.abs(stopped.endSampleContextTime - 1 - 128 / 48000) < 1e-12);
});

test('stop summary exposes an input gap without modifying captured samples', async () => {
  const { processor, context } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000 } });
  processor.process([[new Float32Array(128)]], []);
  context.currentTime = 128 / 48000;
  processor.process([[]], []);
  context.currentTime = 256 / 48000;
  processor.process([[new Float32Array(128)]], []);
  processor.port.onmessage({ data: { type: 'stop' } });
  const stopped = processor.port.messages.at(-1);
  assert.equal(stopped.frames, 256);
  assert.equal(stopped.firstSampleContextTime, 0);
  assert.ok(Math.abs(stopped.endSampleContextTime * 48000 - 384) < 1e-9);
  assert.equal(stopped.missingInputFrames, 128);
  assert.equal(stopped.missingInputBlocks, 1);
  assert.equal(stopped.contextGapFrames, 0);
  assert.equal(stopped.firstMissingInput.frame, 128);
});

test('identifies a 512-frame context gap separately from missing input', async () => {
  const { processor, context } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000 } });
  processor.process([[new Float32Array(128).fill(0.25)]], []);
  context.currentTime = 640 / 48000;
  processor.process([[new Float32Array(128).fill(0.5)]], []);
  processor.port.onmessage({ data: { type: 'stop' } });
  const stopped = processor.port.messages.at(-1);
  assert.equal(stopped.frames, 256);
  assert.equal(stopped.contextGapFrames, 512);
  assert.equal(stopped.contextGapBlocks, 1);
  assert.equal(stopped.firstContextGap.frame, 128);
  assert.equal(stopped.missingInputFrames, 0);
  assert.equal(stopped.contextBackwardBlocks, 0);
});

test('forward and backward context boundaries account for net span without dropping samples', async () => {
  const { processor, context } = await loadProcessor();
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000 } });
  for (const frame of [366080, 366720, 366720, 366976]) {
    context.currentTime = frame / 48000;
    processor.process([[new Float32Array(128).fill(0.25)]], []);
  }
  processor.port.onmessage({ data: { type: 'stop' } });
  const stopped = processor.port.messages.at(-1);
  assert.equal(stopped.frames, 512);
  assert.equal(stopped.contextGapFrames, 640);
  assert.equal(stopped.contextBackwardFrames, 128);
  assert.equal(stopped.contextBackwardBlocks, 1);
  assert.equal(stopped.firstContextBackward.frame, 256);
  const spanFrames = Math.round((stopped.endSampleContextTime - stopped.firstSampleContextTime) * 48000);
  assert.equal(spanFrames - stopped.frames, stopped.contextGapFrames - stopped.contextBackwardFrames);
  assert.equal(processor.port.messages.find((message) => message.type === 'audio').samples.length, 512);
});

test('start notification preserves request boundary clocks without changing first sample timing', async () => {
  const { processor, context } = await loadProcessor();
  context.currentTime = 9.077;
  processor.port.onmessage({ data: { type: 'start', maximumFrames: 1000,
    sentPerfMs: 12000, sentContextTime: 9.077 } });
  context.currentTime = 9.061333333333334;
  processor.process([[new Float32Array(128)]], []);
  const start = processor.port.messages.find((message) => message.type === 'started');
  assert.equal(start.startRequest.sentPerfMs, 12000);
  assert.equal(start.startRequest.sentContextTime, 9.077);
  assert.equal(start.startRequest.receivedContextTime, 9.077);
  assert.equal(start.contextTime, 9.061333333333334);
  assert.equal(processor.totalFrames, 128);
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
