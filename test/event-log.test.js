import assert from 'node:assert/strict';
import test from 'node:test';
import { eventLogSeverity } from '../prototype/event-log.js';

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
