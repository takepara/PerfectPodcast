const SAMPLE_RATE_TARGET = 48000;
const MAX_SESSION_FRAMES = 2 * 60 * 60 * SAMPLE_RATE_TARGET;

class LocalRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.frames = 0;
    this.totalFrames = 0;
    this.maximumFrames = MAX_SESSION_FRAMES;
    this.startAt = null;
    this.armed = false;
    this.started = false;
    this.firstSampleContextTime = null;
    this.endSampleContextTime = null;
    this.expectedProcessFrame = null;
    this.missingInputFrames = 0;
    this.missingInputBlocks = 0;
    this.contextGapFrames = 0;
    this.contextGapBlocks = 0;
    this.contextBackwardBlocks = 0;
    this.contextBackwardFrames = 0;
    this.firstContextBackward = null;
    this.firstMissingInput = null;
    this.firstContextGap = null;
    this.buffer = new Float32Array(SAMPLE_RATE_TARGET);
    this.chunkStartFrame = 0;
    this.levelFrames = 0;
    this.levelPeak = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        if (this.armed || this.started) return;
        this.maximumFrames = Number.isSafeInteger(data.maximumFrames) && data.maximumFrames > 0
          ? Math.min(data.maximumFrames, MAX_SESSION_FRAMES)
          : MAX_SESSION_FRAMES;
        this.startAt = Number.isFinite(data.startAt) ? data.startAt : null;
        this.event = typeof data.eventId === 'string' && Number.isSafeInteger(data.sequence)
          ? { eventId: data.eventId, sequence: data.sequence }
          : null;
        this.startRequest = {
          sentPerfMs: data.sentPerfMs,
          sentContextTime: data.sentContextTime,
          receivedContextTime: currentTime
        };
        this.armed = true;
        this.port.postMessage({ type: 'armed', event: this.event });
      } else if (data.type === 'stop') {
        this.armed = false;
        this.startAt = null;
        this.recording = false;
        this.flush(true);
        this.port.postMessage({ type: 'stopped', frames: this.totalFrames,
          firstSampleContextTime: this.firstSampleContextTime,
          endSampleContextTime: this.endSampleContextTime,
          missingInputFrames: this.missingInputFrames, missingInputBlocks: this.missingInputBlocks,
          contextGapFrames: this.contextGapFrames, contextGapBlocks: this.contextGapBlocks,
          contextBackwardBlocks: this.contextBackwardBlocks, contextBackwardFrames: this.contextBackwardFrames,
          firstMissingInput: this.firstMissingInput, firstContextGap: this.firstContextGap,
          firstContextBackward: this.firstContextBackward });
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

  process(inputs) {
    const input = inputs[0]?.[0];
    const processFrame = Math.round(currentTime * sampleRate);
    if (this.recording) {
      const gap = this.expectedProcessFrame === null ? 0 : processFrame - this.expectedProcessFrame;
      if (gap > 0) {
        this.contextGapFrames += gap;
        this.contextGapBlocks += 1;
        this.firstContextGap ??= { frame: this.totalFrames, contextTime: currentTime, frames: gap };
      } else if (gap < 0) {
        this.contextBackwardBlocks += 1;
        this.contextBackwardFrames -= gap;
        this.firstContextBackward ??= { frame: this.totalFrames, contextTime: currentTime, frames: -gap };
      }
      if (!input?.length) {
        this.missingInputFrames += 128;
        this.missingInputBlocks += 1;
        this.firstMissingInput ??= { frame: this.totalFrames, contextTime: currentTime };
      }
    }
    this.expectedProcessFrame = processFrame + (input?.length || 128);

    if (input) {
      for (let index = 0; index < input.length; index += 1) {
        this.levelPeak = Math.max(this.levelPeak, Math.abs(input[index]));
        if (this.armed && !this.started &&
            (this.startAt === null || currentTime + index / sampleRate >= this.startAt)) {
          this.armed = false;
          this.started = true;
          this.recording = true;
          const contextTime = (processFrame + index) / sampleRate;
          this.firstSampleContextTime = contextTime;
          this.startAt = null;
          this.port.postMessage({
            type: 'started',
            frame: this.totalFrames,
            contextTime,
            startRequest: this.startRequest,
            event: this.event
          });
        }
        if (this.recording && this.totalFrames < this.maximumFrames) {
          this.buffer[this.frames] = input[index];
          this.frames += 1;
          this.totalFrames += 1;
          this.endSampleContextTime = (processFrame + index + 1) / sampleRate;
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
