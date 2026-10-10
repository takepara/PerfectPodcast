import assert from 'node:assert/strict';
import test from 'node:test';
import { connectFirstMicrophoneChannel } from '../prototype/microphone-input.js';
import { createPcm24Wav } from '../prototype/wav-export.js';

for (const channels of [[0.5, 0], [0.5, -0.5], [0.5]]) {
  test(`preserves input 1 amplitude for ${JSON.stringify(channels)}`, async () => {
    const destination = {};
    let output;
    const splitter = {
      connect: (target, channel, input) => {
        assert.equal(target, destination);
        assert.equal(channel, 0);
        assert.equal(input, 0);
        output = channels[channel];
      }
    };
    const context = { createChannelSplitter: (count) => { assert.equal(count, 2); return splitter; } };
    const source = { connect: (target) => assert.equal(target, splitter) };
    assert.equal(connectFirstMicrophoneChannel(context, source, destination), splitter);
    assert.equal(output, 0.5);
    const wav = new DataView(await createPcm24Wav(new Float32Array([output])).arrayBuffer());
    const sample = wav.getUint8(44) | wav.getUint8(45) << 8 | wav.getUint8(46) << 16;
    assert.ok(Math.abs(sample / 0x7fffff - 0.5) < 1 / 0x7fffff);
  });
}
