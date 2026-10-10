import assert from 'node:assert/strict';
import test from 'node:test';
import { eventLogSeverity, resetEventLog } from '../prototype/event-log.js';

for (const isGuest of [false, true]) {
  test(`studio entry clears previous events and defaults ${isGuest ? 'guest closed' : 'host open'}`, () => {
    const panel = { open: isGuest };
    const log = { events: ['old event'], scrollTop: 120, replaceChildren() { this.events = []; } };
    const count = { textContent: '12 EVENTS' };
    resetEventLog({ panel, log, count, isGuest });
    assert.deepEqual(log.events, []);
    assert.equal(log.scrollTop, 0);
    assert.equal(count.textContent, '0 EVENTS');
    assert.equal(panel.open, !isGuest);
    panel.open = !panel.open;
    log.events.push('another session');
    resetEventLog({ panel, log, count, isGuest });
    assert.deepEqual(log.events, []);
    assert.equal(panel.open, !isGuest);
  });
}

test('classifies errors and warnings without coloring normal events', () => {
  assert.equal(eventLogSeverity('Application error', 'TURN unavailable'), 'error');
  assert.equal(eventLogSeverity('ICE candidate warning', 'code=701 count=8'), 'warning');
  assert.equal(eventLogSeverity('Recording timing unavailable'), 'warning');
  assert.equal(eventLogSeverity('Synchronization result save failed'), 'error');
  assert.equal(eventLogSeverity('PeerConnection state', 'connection=failed ice=failed'), 'error');
  assert.equal(eventLogSeverity('Application event', 'difference -39 ms · above 20 ms target'), 'warning');
  assert.equal(eventLogSeverity('Clock sync selected', 'samples=5/5 RTT=2 ms'), 'info');
  assert.equal(eventLogSeverity('Recording start local'), 'info');
});
