import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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
  for (const id of ['statusMessage', 'roomStatus', 'errorText', 'recordingPreparation', 'trackMicDeviceHint', 'transferGraphSummary']) {
    assert.ok(recorder.includes(`id="${id}"`));
  }
  assert.match(recorder, /id="trackMicDeviceHint"[^>]*><\/p>/);
});

test('hides the requested redundant session labels while preserving accessible headings', () => {
  for (const id of ['statusText', 'roomRoleLabel', 'roomHeading', 'networkHeading', 'transferProgressHeading', 'waveformHeading']) {
    const label = recorder.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert.ok(label, `expected ${id} to remain available to assistive technology`);
    assert.match(label[0], /class="[^"]*visually-hidden/);
  }
});

test('removes the placeholder avatar and offers checkbox-based bulk session deletion', () => {
  assert.equal(recorder.includes('class="avatar"'), false);
  assert.match(recorder, /<div class="participant-chip">[\s\S]*?<span id="participantLabel">Participant<\/span><\/div>\s*<button id="deleteSessionButton"/);
  assert.doesNotMatch(recorder, /id="setupFormTitle"|保存したセッション|この端末のゲスト録音/);
  assert.match(recorder, /<div class="panel-heading compact">[\s\S]*?<button id="deleteSelectedSessionsButton"[^>]*>\s*セッション削除/);
  const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
  assert.match(source, /deleteSessionButton\.hidden = !activeSession \|\| roomCall\?\.isGuest === true/);
  assert.match(source, /deleteSessionButton\.disabled = recording \|\| starting \|\| finalizing \|\| switchingMicrophone \|\|/);
  assert.match(source, /Boolean\(roomCall\?\.isActive\)/);
  assert.match(source, /function guestTakesAreStored\(takes\)/);
  assert.match(source, /function deleteSelectedSessions\(\)/);
  assert.match(source, /deleteSessionsAndRecordings\(selectedIds\)/);
  assert.match(source, /選択した.*セッション.*一括削除/);
  assert.match(source, /復元できません/);
  assert.doesNotMatch(source, /選択したセッションと録音を一括削除しました/);
  assert.match(source, /selection\.type = 'checkbox'/);
  assert.match(source, /このセッションに保存された録音・受信音声をすべて削除します/);
  assert.match(source, /database\.transaction\(\['sessions', 'takes', 'chunks'\], 'readwrite'\)/);
  const css = readFileSync(new URL('../prototype/recorder.css', import.meta.url), 'utf8');
  assert.match(css, /\.terminal-ui \.recent-panel \.panel-heading \{ display: flex; align-items: center; justify-content: space-between;/);
  assert.match(css, /\.session-bulk-delete \{ flex: 0 0 auto; margin: 0;/);
  assert.match(css, /\.terminal-ui \.session-entry:first-child \{ border-top: 0;/);
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
  assert.match(css, /\.terminal-ui \.storage-recordings \.take-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.storage-recordings \.take-row:first-child \{ border-top: 0;/);
  assert.match(css, /\.storage-recordings \.take-actions \{ flex-wrap: nowrap; justify-content: end;/);
  assert.match(css, /\.terminal-ui \.storage-recordings \.take-actions \{ justify-content: end;/);
  assert.match(css, /\.terminal-ui \.take-title \{[^}]*font-size: 14px;/);
  assert.match(css, /\.terminal-ui \.take-meta \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.take-action \{[^}]*min-height: 38px;[^}]*font-size: 12px;/);
  const source = readPrototype('recorder.js');
  assert.match(source, /label\.textContent = `\$\{participant\} \$\{String\(take\.number\)\.padStart\(2, '0'\)\}`/);
  assert.match(source, /const duration = formatDuration\(\(take\.frames \|\| 0\) \/ TARGET_RATE\)/);
  assert.match(source, /const size = Number\.isFinite\(take\.bytes\) \? formatBytes\(take\.bytes\) : '—'/);
  assert.match(source, /meta\.textContent = `\$\{duration\} · \$\{size\}`/);
  assert.equal(source.includes('takeCount'), false);
  assert.equal(source.includes('takeStatusLabel'), false);
});

test('offers host-only WAV downloads for stored participant takes and keeps a clickable fallback link', () => {
  const source = readPrototype('recorder.js');
  const renderTakes = source.slice(source.indexOf('async function renderTakes()'), source.indexOf('\nasync function openSession'));
  assert.match(renderTakes, /if \(roomCall\?\.isGuest !== true\)/);
  assert.match(renderTakes, /const exportButton = document\.createElement\('button'\)/);
  assert.match(renderTakes, /take\.remote && take\.hostStored !== true/);

  const exportTake = source.slice(source.indexOf('async function exportTake('), source.indexOf('\nasync function recoverInterruptedTakes'));
  assert.match(exportTake, /downloadLink\.href = url/);
  assert.match(exportTake, /exportButton\.replaceWith\(downloadLink\)/);
  assert.doesNotMatch(exportTake, /downloadLink\.click\(\)/);
});

test('arranges capture, room, and network details in three desktop columns', () => {
  const record = recorder.indexOf('class="panel record-panel"');
  const invite = recorder.indexOf('id="roomPanel" class="panel room-panel"');
  const network = recorder.indexOf('id="networkPanel" class="panel network-panel"');
  const waveform = recorder.indexOf('class="panel waveform-panel"');
  const storage = recorder.indexOf('class="panel storage-panel"');
  assert.ok(record < invite && invite < network && network < waveform && waveform < storage);
  const networkPanel = recorder.slice(network, waveform);
  assert.match(networkPanel, /id="transferProgressCard"/);
  assert.doesNotMatch(networkPanel, /id="transferProgressCard"[^>]*hidden/);
  assert.match(networkPanel, /class="network-metrics"/);
  assert.doesNotMatch(networkPanel, /<details|<summary/);
  assert.match(networkPanel, /id="connectionStats"/);
  assert.match(networkPanel, /id="recordingReadiness"/);
  assert.match(networkPanel, /id="networkProgressErrorRow" hidden/);
  assert.match(networkPanel, /id="transferGraph" width="600" height="96"/);
  assert.equal((networkPanel.match(/<tr>/g) || []).length, 2);
  assert.match(networkPanel, /未転送 \/ 総量/);
  assert.doesNotMatch(networkPanel, /networkUnsubmitted|networkSending|networkAwaitingAck|networkManifest|manifest/);
  assert.match(recorder, /class="studio-grid terminal-grid"/);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.studio-grid \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*grid-template-areas: "record room network" "wave wave storage";/);
  assert.match(css, /\.terminal-ui \.record-panel \{ grid-area: record;/);
  assert.match(css, /\.terminal-ui \.room-panel \{ grid-area: room;/);
  assert.match(css, /\.terminal-ui \.network-panel \{ grid-area: network;/);
  assert.match(css, /\.terminal-ui \.record-panel, \.terminal-ui \.room-panel, \.terminal-ui \.network-panel \{ align-self: stretch; \}/);
  assert.match(css, /\.terminal-ui \.storage-panel \{ align-self: start; \}/);
  assert.match(css, /\.terminal-ui \.network-heading \.terminal-section-code \{[^}]*color: var\(--yellow\);/);
  assert.match(css, /\.terminal-ui \.storage-panel \.terminal-section-code \{[^}]*color: var\(--yellow\);/);
  assert.match(css, /\.transfer-progress \{[^}]*padding: 0;[^}]*border: 0;[^}]*background: transparent;/);
  assert.match(css, /\.terminal-ui \.network-metrics \{ font-size: 11px; line-height: 1\.35; \}/);
  assert.match(css, /\.terminal-ui \.waveform-panel \{ grid-area: wave;/);
  assert.match(css, /\.terminal-ui \.storage-panel \{ grid-area: storage;/);
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*?\.terminal-ui \.studio-grid \{ grid-template-columns: 1fr; grid-template-areas: "record" "room" "network" "wave" "storage"; \}/);
});

test('formats transfer progress as remaining bytes, total bytes, and completion percentage', () => {
  const source = readPrototype('recorder.js');
  const start = source.indexOf('function formatTransferMegabytes(');
  const end = source.indexOf('\nfunction drawTransferGraph(', start);
  const context = {};
  runInNewContext(`${source.slice(start, end)}\nglobalThis.formatTransferRatio = formatTransferRatio;`, context);

  assert.equal(context.formatTransferRatio(1_000_000, 4_000_000), '1.00 MB / 4.00 MB · 完了 75%');
  assert.equal(context.formatTransferRatio(0, 4_000_000), '0.00 MB / 4.00 MB · 完了 100%');
  assert.equal(context.formatTransferRatio(9_000_000, 4_000_000), '4.00 MB / 4.00 MB · 完了 0%');
  assert.equal(context.formatTransferRatio(0, 0), '0.00 MB / 0.00 MB · 完了 —');
});

test('uses readable text sizes throughout the session screen', () => {
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.button \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.status-line \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.room-status,[^{]*\{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.waveform-timeline \{[^}]*font: 12px/);
  assert.match(css, /\.terminal-ui #studioView \.field,[^{]*\{ font-size: 12px; \}/);
});

test('uses readable text sizes on setup and saved-session lists', () => {
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.field \{[^}]*font-size: 14px;/);
  assert.match(css, /\.terminal-ui \.field input,[^{]*\{[\s\S]*?font-size: 14px;/);
  assert.match(css, /\.terminal-ui \.session-entry-name \{ font-size: 14px;/);
  assert.match(css, /\.terminal-ui \.session-entry-meta \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.session-open \{[^}]*font-size: 12px;/);
});

test('places the vertical input meter beside the local waveform', () => {
  const recordPanel = recorder.slice(recorder.indexOf('class="panel record-panel"'), recorder.indexOf('id="roomPanel"'));
  assert.equal(recordPanel.includes('meter-block'), false);
  const waveformTrack = recorder.slice(recorder.indexOf('<div class="waveform-track">'), recorder.indexOf('<div id="remoteWaveformTracks"'));
  assert.match(waveformTrack, /waveform-visual-row[\s\S]*meter-block[\s\S]*role="meter" aria-orientation="vertical"[\s\S]*waveform-canvas-wrap/);
  assert.match(waveformTrack, /waveform-heading-control[\s\S]*microphoneMuteButton[\s\S]*waveform-track-title[\s\S]*waveformParticipant/);
  assert.match(waveformTrack, /waveform-ruler-row[\s\S]*waveform-ruler-spacer[\s\S]*waveMark0[\s\S]*waveform-visual-row/);

  const source = readPrototype('recorder.js');
  assert.match(source, /fill\.style\.height = `\$\{percent\}%`/);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.meter \{ display: flex;[^}]*align-items: flex-end;/);
  assert.match(css, /\.waveform-heading \{ display: grid; grid-template-columns: 74px minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.waveform-ruler-row, \.waveform-visual-row \{ display: grid; grid-template-columns: 74px minmax\(0, 1fr\);/);
  assert.match(css, /\.terminal-ui \.meter \{ width: 24px; height: 100%; min-height: 0;/);
  assert.match(css, /\.terminal-ui \.waveform-heading \{ gap: 12px; \}/);
  assert.match(css, /\.waveform-monitor-grid \{ --waveform-box-height: 100px;/);
  assert.match(css, /\.meter-block \{[^}]*height: var\(--waveform-box-height\); grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(css, /\.waveform-canvas-wrap \{ height: var\(--waveform-box-height\);/);
  assert.match(css, /\.terminal-ui \.waveform-monitor-grid \{ --waveform-box-height: 62px; \}/);
  assert.match(css, /\.terminal-ui \.waveform-heading-control \.meter-mute-button \{ width: 64px; min-width: 64px; min-height: 24px; margin: 0; padding: 2px 3px; font-size: 12px; \}/);
  assert.match(css, /\.remote-mute-state \{ display: inline-flex; width: 64px; min-width: 64px; height: 24px; min-height: 24px; justify-content: center; align-items: center;/);
  assert.match(css, /\.terminal-ui \.waveform-ruler-row \{ font: 12px ui-monospace, monospace; \}/);
  assert.match(css, /\.meter-fill \{[^}]*transition: height \.08s linear/);
});

test('keeps waveform rendering limited to active recording for every participant', () => {
  const source = readPrototype('recorder.js');
  const openSession = source.slice(source.indexOf('async function openSession('), source.indexOf('\nasync function deleteActiveSession'));
  const drawWaveform = source.slice(source.indexOf('function drawWaveform()'), source.indexOf('\nasync function runRequest'));
  const startHandler = source.slice(source.indexOf("if (data.type === 'started')"), source.indexOf("if (data.type === 'level')"));
  const stopRecording = source.slice(source.indexOf('async function stopRecording('), source.indexOf('\nfunction audioContextTimeAtPerformanceTime'));
  assert.doesNotMatch(openSession, /drawWaveform\(\)/);
  assert.match(drawWaveform, /if \(!recording\) return/);
  assert.doesNotMatch(drawWaveform, /previewAnalyserNode|previewSamples/);
  assert.match(startHandler, /drawWaveform\(\)/);
  assert.match(stopRecording, /recording = false;\s*stopWaveformRendering\(\)/);

  const roomCall = readPrototype('room-call.js');
  const remoteDraw = roomCall.slice(roomCall.indexOf('drawRemoteWaveform(waveform)'), roomCall.indexOf('\n  stopRemoteWaveform'));
  assert.match(remoteDraw, /this\.waveformRecordingStartedAt === null/);
  assert.match(remoteDraw, /if \(this\.waveformRecordingStartedAt !== null\) \{/);
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
      assert.equal(elements.get('recentPanel').hidden, false);
    }
    assert.match(elements.get('statusMessage').textContent, /招待リンクが正しくありません/);
    assert.equal(elements.get('openStudioButton').disabled, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
