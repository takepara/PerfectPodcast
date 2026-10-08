import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clearHostProfile, profileDisplayName, readHostProfile, saveHostProfile } from '../src/auth-profile.js';

test('autofills an empty setup field without overwriting typed names or an open session', async () => {
  const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
  const start = source.indexOf('    void getHostDisplayName(authSession)');
  const autofill = source.slice(start, source.indexOf("    $('logoutButton').hidden", start));
  for (const [value, activeSession, expected] of [['', null, 'Host'], ['Custom', null, 'Custom'], ['', {}, '']]) {
    const context = vm.createContext({
      getHostDisplayName: async () => 'Host', authSession: { sub: 'host' },
      participantNameInput: { value }, activeSession
    });
    vm.runInContext(autofill, context);
    await Promise.resolve();
    assert.equal(context.participantNameInput.value, expected);
  }
});

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test('uses Auth0 name then nickname without falling back to an email address', () => {
  assert.equal(profileDisplayName({ sub: 'host', name: ' 山田 花子 ', nickname: 'nick' }, 'host'), '山田 花子');
  assert.equal(profileDisplayName({ sub: 'host', name: ' ', nickname: 'nick' }, 'host'), 'nick');
  assert.equal(profileDisplayName({ sub: 'host', email: 'private@example.test' }, 'host'), '');
  assert.equal(profileDisplayName({ sub: 'other', name: 'Someone' }, 'host'), '');
  assert.equal(profileDisplayName({ sub: 'host', name: 'a'.repeat(100) }, 'host').length, 60);
});

test('passes only the display name and subject across pages and checks account identity', () => {
  const store = storage();
  saveHostProfile(store, { sub: 'host', name: 'Host', email: 'private@example.test' }, 'host');
  assert.equal(readHostProfile(store, 'host'), 'Host');
  assert.equal(readHostProfile(store, 'other'), '');
  assert.deepEqual(JSON.parse(store.getItem('perfectpodcast-host-profile')), { sub: 'host', name: 'Host' });
  clearHostProfile(store);
  assert.equal(readHostProfile(store, 'host'), '');
});

test('missing profiles clear stale names and malformed storage does not break setup', () => {
  const store = storage();
  saveHostProfile(store, { sub: 'host', name: 'Host' }, 'host');
  saveHostProfile(store, undefined, 'host');
  assert.equal(readHostProfile(store, 'host'), '');
  store.setItem('perfectpodcast-host-profile', 'invalid json');
  assert.equal(readHostProfile(store, 'host'), '');
  assert.equal(readHostProfile({ getItem() { throw new Error('blocked'); } }, 'host'), '');
});
