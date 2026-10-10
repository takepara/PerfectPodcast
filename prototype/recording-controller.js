const transitions = {
  idle: ['preparing'], preparing: ['prepared', 'armed', 'finalizing', 'idle'],
  prepared: ['armed', 'finalizing', 'idle'], armed: ['capturing', 'finalizing', 'idle'],
  capturing: ['finalizing'], finalizing: ['idle']
};

export class RecordingController {
  constructor({ onStateChange = () => {} } = {}) {
    this.state = 'idle';
    this.onStateChange = onStateChange;
    this.operation = 0;
    this.cancelRequested = false;
    this.startTask = null;
    this.stopTask = null;
    this.lastFailure = null;
  }

  get snapshot() {
    return Object.freeze({ state: this.state, operation: this.operation,
      recording: ['armed', 'capturing'].includes(this.state), onAir: this.state === 'capturing',
      starting: this.startTask !== null || this.state === 'preparing',
      finalizing: this.state === 'finalizing',
      pending: ['preparing', 'prepared', 'armed'].includes(this.state),
      cancelRequested: this.cancelRequested, lastFailure: this.lastFailure });
  }

  emit() { this.onStateChange(this.snapshot); }

  transition(state) {
    if (state === this.state) return;
    if (!transitions[this.state].includes(state)) throw new Error(`Invalid recording transition: ${this.state} → ${state}`);
    this.state = state;
    this.emit();
  }

  isCurrent(operation) { return operation === this.operation && !this.cancelRequested && this.state !== 'idle' && this.state !== 'finalizing'; }

  prepared(operation) {
    if (!this.isCurrent(operation)) return false;
    this.transition('prepared');
    return true;
  }

  arm(operation) {
    if (!this.isCurrent(operation)) throw new Error('The recording start was canceled.');
    this.transition('armed');
  }

  captured(operation) {
    if (!this.isCurrent(operation) || this.state !== 'armed') return false;
    this.transition('capturing');
    return true;
  }

  cancel() { this.cancelRequested = true; this.emit(); }

  start(action) {
    if (this.startTask) return this.startTask;
    if (['armed', 'capturing'].includes(this.state)) return Promise.resolve(true);
    if (this.state === 'finalizing') return Promise.resolve(false);
    if (this.state === 'idle') {
      this.operation += 1;
      this.cancelRequested = false;
      this.lastFailure = null;
      this.transition('preparing');
    }
    const operation = this.operation;
    // Schedule after assigning startTask so stop can join even a synchronous callback.
    const task = Promise.resolve().then(() => action(operation)).then((result) => {
      if (!result && this.state !== 'finalizing' && this.operation === operation) this.transition('idle');
      return result;
    }).catch((error) => {
      this.lastFailure = { stage: 'start', message: error.message };
      if (this.state !== 'finalizing') this.transition('idle');
      throw error;
    }).finally(() => { if (this.startTask === task) this.startTask = null; this.emit(); });
    this.startTask = task;
    this.emit();
    return task;
  }

  stop(action) {
    if (this.stopTask) return this.stopTask;
    if (this.state === 'idle') return Promise.resolve(true);
    const startTask = this.startTask;
    this.cancelRequested = true;
    this.transition('finalizing');
    const task = Promise.resolve().then(async () => {
      await startTask?.catch(() => {});
      return action();
    }).finally(() => {
      this.startTask = null;
      this.stopTask = null;
      this.transition('idle');
    });
    this.stopTask = task;
    return task;
  }

  async finalize({ stopCapture, drain, cleanup, persist, notify, recoveryReason = null }) {
    let failure = recoveryReason ? { stage: 'capture', message: String(recoveryReason) } : null;
    let observation = null;
    try {
      observation = await stopCapture();
      if (!observation) failure ||= { stage: 'stop', message: 'The AudioWorklet stop was not confirmed. The final section may be incomplete.' };
    } catch (error) { failure ||= { stage: 'stop', message: error.message }; }
    try { await drain(observation); } catch (error) { failure ||= { stage: 'chunks', message: error.message }; }
    try { await cleanup(); } catch (error) { failure ||= { stage: 'cleanup', message: error.message }; }
    const completion = { status: failure ? 'recovered' : 'stopped', tailUnknown: Boolean(failure), recoveryReason: failure?.message ?? null };
    let take;
    try { take = await persist(completion); }
    catch (error) {
      failure = { stage: 'completion', message: error.message };
      this.lastFailure = failure;
      return { success: false, completionSaved: false, failure, take: null, observation };
    }
    let notificationFailure = null;
    if (notify) {
      try { await notify(take); } catch (error) { notificationFailure = { stage: 'notification', message: error.message }; }
    }
    this.lastFailure = failure;
    return { success: !failure, completionSaved: true, failure, notificationFailure, take, observation };
  }
}

export function confirmWorkletStop(port, {
  timeoutMs = 3000, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout
} = {}) {
  if (!port) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const handler = port.onmessage;
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onmessage = handler;
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    port.onmessage = (event) => {
      try {
        handler?.(event);
        if (event.data.type === 'stopped') finish(event.data);
      } catch (error) { finish(null, error); }
    };
    try { port.postMessage({ type: 'stop' }); } catch (error) { finish(null, error); }
  });
}
