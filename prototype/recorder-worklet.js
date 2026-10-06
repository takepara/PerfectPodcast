const SAMPLE_RATE_TARGET = 48000;
const MAX_SESSION_FRAMES = 2 * 60 * 60 * SAMPLE_RATE_TARGET;

class LocalRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.frames = 0;
    this.totalFrames = 0;
    this.maximumFrames = MAX_SESSION_FRAMES;
    this.buffer = new Float32Array(SAMPLE_RATE_TARGET);
    this.chunkStartFrame = 0;
    this.levelFrames = 0;
    this.levelPeak = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.maximumFrames = Number.isSafeInteger(data.maximumFrames) && data.maximumFrames > 0
          ? Math.min(data.maximumFrames, MAX_SESSION_FRAMES)
          : MAX_SESSION_FRAMES;
        this.recording = true;
      } else if (data.type === 'stop') {
        this.recording = false;
        this.flush(true);
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush(final = false) {
    if (this.frames === 0) return;
    const samples = this.buffer.slice(0, this.frames);
    this.port.postMessage({ type: 'audio', samples, final, startFrame: this.chunkStartFrame }, [samples.buffer]);
    this.chunkStartFrame += this.frames;
    this.frames = 0;
    this.buffer = new Float32Array(SAMPLE_RATE_TARGET);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);

    if (input) {
      for (let index = 0; index < input.length; index += 1) {
        this.levelPeak = Math.max(this.levelPeak, Math.abs(input[index]));
        if (this.recording && this.totalFrames < this.maximumFrames) {
          this.buffer[this.frames] = input[index];
          this.frames += 1;
          this.totalFrames += 1;
          if (this.totalFrames === this.maximumFrames) {
            this.recording = false;
            this.flush(true);
            this.port.postMessage({ type: 'limit-reached' });
          } else if (this.frames === SAMPLE_RATE_TARGET) {
            this.flush();
          }
        }
      }
      this.levelFrames += input.length;
      if (this.levelFrames >= SAMPLE_RATE_TARGET / 10) {
        this.port.postMessage({ type: 'level', peak: this.levelPeak });
        this.levelFrames = 0;
        this.levelPeak = 0;
      }
    }
    return true;
  }
}

registerProcessor('perfectpodcast-local-recorder', LocalRecorderProcessor);
