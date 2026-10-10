export function resetEventLog({ panel, log, count, isGuest }) {
  log.replaceChildren();
  log.scrollTop = 0;
  count.textContent = '0 EVENTS';
  panel.open = !isGuest;
}

export function eventLogSeverity(event, details = '') {
  if (/error|failed|failure/iu.test(event)) return 'error';
  if (/warning|unavailable|ignored|not sent/iu.test(event)) return 'warning';
  if (/\b(?:failed|failure|error|connection=failed|ice=failed)\b/iu.test(details)) return 'error';
  if (/\b(?:warning|unavailable|above 20 ms target|timed out|timeout)\b/iu.test(details)) return 'warning';
  return 'info';
}
