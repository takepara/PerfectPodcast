import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('const renderedTakeRows ='), source.indexOf('\nasync function openSession'));
function element() {
  return { children: [], append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }, addEventListener() {}, querySelector() { return null; },
    insertBefore(child, before) { const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); } };
}
async function rows(guest = false) {
  const takes = [
    { id: 'host', sessionId: 'session', participant: 'Host', number: 1, frames: 48000, chunks: 1, bytes: 144044, status: 'stopped' },
    { id: 'guest', sessionId: 'session', participant: 'Guest', number: 1, frames: 48000, chunks: 1, bytes: 144044, status: 'stopped', remote: !guest, transferGeneration: 'generation', hostStored: true }
  ];
  const list = element();
  let reads = 0;
  const context = vm.createContext({ activeSession: { id: 'session' },
    repository: { sessionSummary: async () => { reads += 1; return { takes, bytes: 288088, localFrames: 48000 }; } },
    $: () => ({}), MAX_SESSION_FRAMES: 345600000, sessionLimitReached: false,
    takeList: list, document: { createElement: element }, TARGET_RATE: 48000,
    formatDuration: () => '00:01', formatBytes: () => '144 KB',
    synchronizationForTake: () => ({ differenceMs: 0 }), roomCall: { isGuest: guest },
    assessAlignment: () => ({ available: false, reason: 'Host timing unstable.' })
  });
  vm.runInContext(render, context);
  await context.renderTakes();
  const firstRows = [...list.children];
  await context.renderTakes();
  assert.equal(reads, 2, 'one indexed summary read per render also supplies capacity');
  assert.equal(list.children[0], firstRows[0], 'unchanged rows are not rebuilt');
  assert.equal(list.children[1], firstRows[1]);
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
