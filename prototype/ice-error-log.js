export function createIceErrorLog(log, timers = globalThis) {
  const pending = new Map();
  let timer = null;
  function flush() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    for (const { code, reason, count } of pending.values()) {
      log('ICE candidate warning', `code=${code} count=${count} ${reason}`);
    }
    pending.clear();
  }
  return {
    add(event) {
      const code = Number.isInteger(event.errorCode) ? event.errorCode : 'unknown';
      const reason = String(event.errorText || 'Unknown ICE candidate error').replace(/\s+/gu, ' ').trim().slice(0, 120);
      const key = `${code}:${reason}`;
      const group = pending.get(key);
      if (group) group.count += 1;
      else pending.set(key, { code, reason, count: 1 });
      if (timer === null) timer = timers.setTimeout(flush, 250);
    },
    flush
  };
}
