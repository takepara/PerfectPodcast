import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('async function renderTakes()'), source.indexOf('\nasync function openSession'));
function element() {
  return { children: [], append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }, addEventListener() {} };
}
async function rows(guest = false) {
  const takes = [
    { id: 'host', sessionId: 'session', participant: 'Host', number: 1, frames: 48000, chunks: 1, bytes: 144044, status: 'stopped' },
    { id: 'guest', sessionId: 'session', participant: 'Guest', number: 1, frames: 48000, chunks: 1, bytes: 144044, status: 'stopped', remote: !guest, transferGeneration: 'generation', hostStored: true }
  ];
  const list = element();
  const context = vm.createContext({ activeSession: { id: 'session' }, loadAll: async () => takes,
    takeList: list, document: { createElement: element }, TARGET_RATE: 48000,
    formatDuration: () => '00:01', formatBytes: () => '144 KB',
    synchronizationForTake: () => ({ differenceMs: 0 }), roomCall: { isGuest: guest },
    assessAlignment: () => ({ available: false, reason: 'Host timing unstable.' })
  });
  vm.runInContext(render, context);
  await context.renderTakes();
  return list.children;
}

test('host inventory separates name, duration-size, buttons and actionable notices', async () => {
  const [host, guest] = await rows();
  assert.equal(host.children.length, 2, 'normal host recording has no diagnostic notice');
  assert.equal(host.children[0].children[0].textContent, 'Host 01');
  assert.equal(host.children[0].children[1].textContent, '00:01 · 144 KB');
  assert.equal(host.children[1].children.length, 1);
  assert.equal(guest.children[1].children.length, 1);
  assert.equal(guest.children.length, 2, 'no alignment diagnostics in normal inventory');
});

test('guest inventory shows delivery confirmation below details without misleading sync diagnostics', async () => {
  const [, guest] = await rows(true);
  assert.equal(guest.children[0].children[1].textContent, '00:01 · 144 KB');
  assert.equal(guest.children[1].children.length, 0);
  assert.equal(guest.children[2].children[0].textContent, 'Saved on host.');
});
