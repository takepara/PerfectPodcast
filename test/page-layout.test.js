import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RoomCall } from '../prototype/room-call.js';

const readPrototype = (name) => readFileSync(new URL(`../prototype/${name}`, import.meta.url), 'utf8');
const index = readPrototype('index.html');
const recorder = readPrototype('recorder.html');

test('login and recorder use identical brand markup and a shared stylesheet', () => {
  const brand = /<a class="brand"[\s\S]*?<\/a>/;
  assert.equal(index.match(brand)[0], recorder.match(brand)[0]);
  for (const page of [index, recorder]) {
    assert.match(page, /<link rel="stylesheet" href="\.\/recorder.css">/);
    assert.match(page, /<header class="topbar">/);
  }
});

test('login explains the studio and guest access with a plain login button', () => {
  assert.match(index, /id="loginButton"[^>]*>ログイン<\/button>/);
  assert.equal(index.includes('Auth0でログイン'), false);
  assert.match(index, /id="loginHeading" class="login-heading">高音質ポッドキャスト収録<\/h1>/);
  assert.match(index, /参加者ごとの音声を24-bit \/ 48 kHzで端末に録音。/);
  assert.match(index, /ホストとして収録を始めるには/);
  assert.match(index, /ゲストの方は、ホストから届いた招待リンク/);
  assert.match(index, /class="login-art" aria-hidden="true"/);
});

test('removes recorder instructions but retains live statuses and errors', () => {
  for (const id of ['setupTitle', 'setupInstructions', 'roomInstructions', 'localStorageNotice', 'transferProgressDescription']) {
    assert.equal(recorder.includes(`id="${id}"`), false);
  }
  assert.equal(index.includes('許可されたAuth0アカウント'), false);
  for (const id of ['setupMessage', 'roomStatus', 'errorText', 'recordingPreparation', 'trackMicDeviceHint', 'transferGraphSummary']) {
    assert.ok(recorder.includes(`id="${id}"`));
  }
  assert.match(recorder, /id="trackMicDeviceHint"[^>]*><\/p>/);
});

test('removes the placeholder avatar and adds a host-controlled session delete button', () => {
  assert.equal(recorder.includes('class="avatar"'), false);
  assert.match(recorder, /<div class="participant-chip">[\s\S]*?<span id="participantLabel">Participant<\/span><\/div>\s*<button id="deleteSessionButton"/);
  const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
  assert.match(source, /deleteSessionButton\.hidden = !activeSession \|\| roomCall\?\.isGuest === true/);
  assert.match(source, /deleteSessionButton\.disabled = recording \|\| starting \|\| finalizing \|\| switchingMicrophone \|\|/);
  assert.match(source, /Boolean\(roomCall\?\.isActive\)/);
  assert.match(source, /このセッションに保存された録音・受信音声をすべて削除します/);
  assert.match(source, /database\.transaction\(\['sessions', 'takes', 'chunks'\], 'readwrite'\)/);
});

test('places compact name-and-sequence WAV rows inside the device storage panel', () => {
  const storagePanelStart = recorder.indexOf('<aside class="panel storage-panel"');
  const storagePanelEnd = recorder.indexOf('</aside>', storagePanelStart);
  const storagePanel = recorder.slice(storagePanelStart, storagePanelEnd);
  assert.match(storagePanel, /<section class="storage-recordings" aria-label="このセッションの録音">/);
  assert.match(storagePanel, /id="takeList" class="take-list"/);
  assert.equal(storagePanel.includes('takesHeading'), false);
  assert.equal(storagePanel.includes('takeCount'), false);
  assert.equal(recorder.includes('class="panel takes-panel"'), false);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.storage-recordings \.take-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.storage-recordings \.take-row:first-child \{ border-top: 0;/);
  assert.match(css, /\.storage-recordings \.take-actions \{ flex-wrap: nowrap; justify-content: end;/);
  const source = readPrototype('recorder.js');
  assert.match(source, /label\.textContent = `\$\{participant\} \$\{String\(take\.number\)\.padStart\(2, '0'\)\}`/);
  assert.match(source, /const duration = formatDuration\(\(take\.frames \|\| 0\) \/ TARGET_RATE\)/);
  assert.match(source, /const size = Number\.isFinite\(take\.bytes\) \? formatBytes\(take\.bytes\) : '—'/);
  assert.match(source, /meta\.textContent = `\$\{duration\} · \$\{size\}`/);
  assert.equal(source.includes('takeCount'), false);
  assert.equal(source.includes('takeStatusLabel'), false);
});

test('role UI works with removed instruction elements and keeps invalid invitation errors', () => {
  const originalDocument = globalThis.document;
  const elements = new Map();
  for (const id of recorder.matchAll(/id="([^"]+)"/g)) {
    elements.set(id[1], {
      classList: { toggle() {} },
      querySelector: () => ({ classList: { toggle() {} } })
    });
  }
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };
  try {
    for (const inviteMode of [false, true]) {
      RoomCall.prototype.applyRoleUI.call({
        inviteMode, invitation: null, setRemoteWaveState() {}, setStatus() {}
      });
      assert.equal(elements.get('roleBadge').textContent, inviteMode ? 'ゲスト' : 'ホスト');
    }
    assert.match(elements.get('setupMessage').textContent, /招待リンクが正しくありません/);
    assert.equal(elements.get('openStudioButton').disabled, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
