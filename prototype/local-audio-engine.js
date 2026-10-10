import { connectFirstMicrophoneChannel } from './microphone-input.js';

export class LocalAudioEngine {
  constructor({
    createContext = (options) => new AudioContext(options),
    createWorklet = (context, name, options) => new AudioWorkletNode(context, name, options),
    onStateChange = () => {}
  } = {}) {
    this.createContext = createContext;
    this.createWorklet = createWorklet;
    this.onStateChange = onStateChange;
    this.context = null;
    this.graph = null;
    this.stream = null;
    this.streams = new Set();
    this.moduleReady = null;
    this.operation = 0;
    this.stateListener = null;
  }

  prime() {
    if (!this.context || this.context.state === 'closed') {
      const context = this.createContext({ sampleRate: 48000 });
      if (context.sampleRate !== 48000) {
        void context.close();
        throw new Error(`This device’s AudioContext is ${context.sampleRate} Hz. 48,000 Hz is required.`);
      }
      this.context = context;
      this.moduleReady = null;
      this.stateListener = () => this.onStateChange(context.state);
      context.addEventListener('statechange', this.stateListener);
    }
    const context = this.context;
    const resume = context.state === 'running'
      ? Promise.resolve(null)
      : context.resume().then(() => null, (error) => error);
    return { context, resume };
  }

  async checkReadiness(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live' || track.muted) {
      throw new Error('No active microphone input is available.');
    }
    const { context, resume } = this.prime();
    const error = await resume;
    if (error) throw error;
    await this.loadModule(context);
    if (context !== this.context || context.state !== 'running') {
      throw new Error('The recording AudioContext is not running.');
    }
    return true;
  }

  loadModule(context) {
    if (!this.moduleReady) {
      this.moduleReady = context.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url)).catch((error) => {
        if (this.context === context) this.moduleReady = null;
        throw error;
      });
    }
    return this.moduleReady;
  }

  startPreview(stream) {
    return this.installGraph(stream, 'preview');
  }

  startTake(stream) {
    return this.installGraph(stream, 'take');
  }

  async installGraph(stream, mode) {
    const operation = ++this.operation;
    this.streams.add(stream);
    const { context, resume } = this.prime();
    const error = await resume;
    if (error) throw error;
    await this.loadModule(context);
    if (operation !== this.operation || context !== this.context) {
      throw new Error('Audio input preparation was canceled.');
    }
    if (context.state !== 'running') throw new Error('The recording AudioContext is not running.');
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('Microphone input ended before audio preparation completed.');
    }
    const graph = { context, stream, mode, source: null, input: null, analyser: null, recorder: null };
    try {
      graph.source = context.createMediaStreamSource(stream);
      graph.analyser = context.createAnalyser();
      graph.analyser.fftSize = 2048;
      graph.analyser.smoothingTimeConstant = 0.65;
      graph.recorder = this.createWorklet(context, 'perfectpodcast-local-recorder', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit'
      });
      graph.input = connectFirstMicrophoneChannel(context, graph.source, graph.analyser);
      graph.analyser.connect(graph.recorder);
    } catch (error) {
      this.disconnect(graph);
      throw error;
    }
    const previousStream = this.stream;
    this.disconnect(this.graph);
    this.graph = graph;
    this.stream = stream;
    if (previousStream && previousStream !== stream) {
      previousStream.getTracks().forEach((track) => track.stop());
      this.streams.delete(previousStream);
    }
    return graph;
  }

  disconnect(graph) {
    if (!graph) return;
    if (graph.recorder) graph.recorder.port.onmessage = null;
    graph.source?.disconnect();
    graph.input?.disconnect();
    graph.analyser?.disconnect();
    graph.recorder?.disconnect();
  }

  stopGraph() {
    this.operation += 1;
    this.disconnect(this.graph);
    this.graph = null;
  }

  async dispose() {
    this.stopGraph();
    const context = this.context;
    if (context && this.stateListener) context.removeEventListener('statechange', this.stateListener);
    this.context = null;
    this.moduleReady = null;
    this.stateListener = null;
    for (const stream of this.streams) stream.getTracks().forEach((track) => {
      if (track.readyState !== 'ended') track.stop();
    });
    this.streams.clear();
    this.stream = null;
    if (context && context.state !== 'closed') await context.close();
  }
}
