import assert from 'node:assert/strict';
import test from 'node:test';
import { createIceErrorLog } from '../prototype/ice-error-log.js';

test('groups repeated ICE errors across addresses and ports into one warning', () => {
  const logs = [];
  const callbacks = [];
  const logger = createIceErrorLog((...entry) => logs.push(entry), {
    setTimeout(callback, delay) { assert.equal(delay, 250); callbacks.push(callback); return callbacks.length; },
    clearTimeout() {}
  });
  for (let index = 0; index < 8; index += 1) logger.add({ errorCode: 701,
    errorText: 'Address not associated with the desired network interface.', address: 'private-address', port: 57470 + index });
  assert.equal(callbacks.length, 1);
  assert.equal(logs.length, 0);
  callbacks[0]();
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /code=701 count=8/);
  assert.equal(logs[0][1].includes('private-address'), false);
  logger.flush();
  assert.equal(logs.length, 1);
});

test('preserves distinct error reasons and flushes pending warnings on cleanup', () => {
  const logs = [];
  const logger = createIceErrorLog((...entry) => logs.push(entry), { setTimeout: () => 1, clearTimeout() {} });
  logger.add({ errorCode: 701, errorText: 'Network interface unavailable' });
  logger.add({ errorCode: 701, errorText: 'Server unreachable' });
  logger.flush();
  assert.equal(logs.length, 2);
  assert.match(logs[0][1], /count=1 Network interface unavailable/);
  assert.match(logs[1][1], /count=1 Server unreachable/);
});
