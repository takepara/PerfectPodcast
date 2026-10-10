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
  assert.match(index, /id="loginButton"[^>]*>Log In<\/button>/);
  assert.equal(index.includes('Log in with Auth0'), false);
  assert.match(index, /id="loginHeading" class="login-heading">High-Quality Podcast Recording<\/h1>/);
  assert.match(index, /Record each participant locally in 24-bit \/ 48 kHz/);
  assert.match(index, /Log in to start a recording session as the host/);
  assert.match(index, /Guests can join using the invitation link from the host/);
  assert.match(index, /class="login-art" aria-hidden="true"/);
});

test('removes recorder instructions but retains live statuses and errors', () => {
  for (const id of ['setupTitle', 'setupInstructions', 'roomInstructions', 'localStorageNotice', 'transferProgressDescription']) {
    assert.equal(recorder.includes(`id="${id}"`), false);
  }
  assert.equal(index.includes('authorized Auth0 account'), false);
  for (const id of ['statusMessage', 'roomStatus', 'errorText', 'recordingPreparation', 'trackMicDeviceHint', 'transferGraphSummary']) {
    assert.ok(recorder.includes(`id="${id}"`));
  }
  assert.match(recorder, /id="trackMicDeviceHint"[^>]*><\/p>/);
});

test('panel titles have no dashed separator and event log has an accessible disclosure', () => {
  const css = readPrototype('recorder.css');
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/panel-heading|network-event-heading|waveform-panel-heading/.test(rule[1])) {
      assert.doesNotMatch(rule[2], /border-bottom:\s*[^;]*dashed/);
    }
  }
  assert.match(recorder, /<details id="networkEventPanel"[^>]*open>[\s\S]*<summary class="network-event-heading">[\s\S]*<\/summary>[\s\S]*id="networkEventLog"[\s\S]*<\/details>/);
});

test('shows a scrollable event log for studio events below the studio panels', () => {
  const studio = recorder.slice(recorder.indexOf('<section id="studioView"'), recorder.indexOf('<div id="notice"'));
  assert.match(studio, /class="panel network-event-panel"[\s\S]*>EVENT LOG<\/span>[\s\S]*id="networkEventCount"[\s\S]*id="networkEventLog"[^>]*aria-label="Event log"[^>]*role="log"[^>]*tabindex="0"/);
  assert.ok(studio.indexOf('class="panel network-event-panel"') > studio.indexOf('class="studio-grid terminal-grid"'));
  const source = readPrototype('recorder.js');
  assert.match(source, /function appendNetworkEvent\(event, details = ''\)/);
  assert.match(source, /line\.textContent = `\$\{new Date\(\)\.toISOString\(\)\}/);
  assert.match(source, /eventLogSeverity\(event, details\)/);
  assert.match(source, /if \(wasAtBottom\) log\.scrollTop = log\.scrollHeight/);
  assert.match(source, /onNetworkEvent: appendNetworkEvent/);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.network-event-log \{ height: 320px;[^}]*background: #050906;[^}]*font-size: 11px;/);
});

test('hides the requested redundant session labels while preserving accessible headings and status badges', () => {
  for (const id of ['roomRoleLabel', 'roomHeading', 'networkHeading', 'transferProgressHeading', 'waveformHeading']) {
    const label = recorder.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert.ok(label, `expected ${id} to remain available to assistive technology`);
    assert.match(label[0], /class="[^"]*visually-hidden/);
  }
  assert.match(recorder, /id="captureStatusBadge" class="onair-badge off" role="status" aria-label="Not on air"/);
  assert.match(recorder, /<span class="onair-light" aria-hidden="true"><\/span><span>ON AIR<\/span>/);
});

test('allows editing and persists the studio session name for the session list', () => {
  assert.match(recorder, /<h1><input id="studioTitle" class="studio-title-input" type="text" maxlength="120" aria-label="Session name"/);
  assert.match(recorder, /<span id="guestStudioTitle" class="studio-title-display" hidden><\/span>/);
  const source = readPrototype('recorder.js');
  const saveName = source.slice(source.indexOf('function saveStudioSessionName()'), source.indexOf('\nasync function deleteSessionsAndRecordings'));
  const openSession = source.slice(source.indexOf('async function openSession('), source.indexOf('\nasync function deleteActiveSession'));
  const sessionList = source.slice(source.indexOf('async function refreshSessionList()'), source.indexOf('\nfunction isGuestLocalSession'));
  assert.match(saveName, /session\.name = name;[\s\S]*persistSession\(sessionToSave\)/);
  assert.match(saveName, /roomCall\?\.setSessionName\(sessionToSave\.name\)/);
  assert.match(saveName, /roomCall\?\.isGuest === true/);
  assert.match(source, /studioTitleInput\.addEventListener\('input', \(\) => \{ void saveStudioSessionName\(\); \}\)/);
  assert.match(source, /if \(!await saveStudioSessionName\(\)\) return;/);
  assert.match(openSession, /\$\('studioTitle'\)\.value = session\.name;[\s\S]*?const guestView = roomCall\?\.isGuest === true;[\s\S]*?\$\('studioTitle'\)\.hidden = guestView;[\s\S]*?\$\('guestStudioTitle'\)\.textContent = session\.name;[\s\S]*?\$\('guestStudioTitle'\)\.hidden = !guestView/);
  assert.match(openSession, /roomCall\?\.isGuest && roomCall\.remoteSessionName/);
  assert.match(sessionList, /name\.textContent = session\.name/);
  assert.match(source, /onSessionName: async \(name\) => \{[\s\S]*?\$\('guestStudioTitle'\)\.textContent = name;[\s\S]*?persistSession\(\{ \.\.\.activeSession \}\)/);
  assert.match(source, /name: `Recording \$\{sessionName\}`/);
});

test('removes the placeholder avatar and offers checkbox-based bulk session deletion', () => {
  assert.equal(recorder.includes('class="avatar"'), false);
  assert.match(recorder, /<div class="participant-chip">[\s\S]*?<span id="participantLabel">Participant<\/span><\/div>\s*<button id="deleteSessionButton"/);
  assert.doesNotMatch(recorder, /id="setupFormTitle"|Saved sessions|Guest recordings on this device/);
  assert.match(recorder, /<div class="panel-heading compact">[\s\S]*?<button id="deleteSelectedSessionsButton"[^>]*>\s*Delete Sessions/);
  const source = readFileSync(new URL('../prototype/recorder.js', import.meta.url), 'utf8');
  assert.match(source, /deleteSessionButton\.hidden = !activeSession \|\| roomCall\?\.isGuest === true/);
  assert.match(source, /deleteSessionButton\.disabled = recordingController\.snapshot\.recording \|\| recordingController\.snapshot\.starting \|\| recordingController\.snapshot\.finalizing \|\| switchingMicrophone \|\|/);
  assert.match(source, /Boolean\(roomCall\?\.isActive\)/);
  assert.match(source, /function guestTakesAreStored\(takes\)/);
  assert.match(source, /function deleteSelectedSessions\(\)/);
  assert.match(source, /deleteSessionsAndRecordings\(selectedIds\)/);
  assert.match(source, /Delete guest recordings from/);
  assert.match(source, /selected session/);
  assert.match(source, /permanently remove/);
  assert.doesNotMatch(source, /Selected sessions and recordings deleted/);
  assert.match(source, /selection\.type = 'checkbox'/);
  assert.match(source, /Delete .*all recordings and received audio saved in this session/);
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
  assert.match(storagePanel, /<h2 id="storageHeading" class="terminal-section-code">LOCAL FILE INVENTORY<\/h2>/);
  assert.doesNotMatch(storagePanel, />Local Storage</);
  assert.match(storagePanel, /<section class="storage-recordings" aria-label="Recordings in this session">/);
  assert.match(storagePanel, /id="takeList" class="take-list"/);
  assert.equal(storagePanel.includes('takesHeading'), false);
  assert.equal(storagePanel.includes('takeCount'), false);
  assert.equal(recorder.includes('class="panel takes-panel"'), false);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.storage-recordings \.take-row \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.terminal-ui \.storage-recordings \.take-row \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.storage-recordings \.take-row:first-child \{ border-top: 0;/);
  assert.match(css, /\.storage-recordings \.take-actions \{ flex-wrap: wrap; justify-content: start;/);
  assert.match(css, /\.terminal-ui \.storage-recordings \.take-actions \{ justify-content: start;/);
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
  assert.match(networkPanel, /id="connectionPath"/);
  assert.match(networkPanel, /id="networkProgressErrorRow" hidden/);
  assert.match(networkPanel, /id="transferGraph" width="600" height="96"/);
  assert.doesNotMatch(networkPanel, /transfer-graph-legend/);
  assert.equal((networkPanel.match(/<tr>/g) || []).length, 3);
  assert.match(networkPanel, /Remaining \/ Total/);
  assert.doesNotMatch(networkPanel, /networkUnsubmitted|networkSending|networkAwaitingAck|networkManifest|manifest/);
  assert.match(recorder, /class="studio-grid terminal-grid"/);
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.studio-grid \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*grid-template-areas: "record room network" "wave wave storage";/);
  assert.match(css, /\.terminal-ui \.record-panel \{ grid-area: record;/);
  assert.match(css, /\.terminal-ui \.room-panel \{ grid-area: room;/);
  assert.match(css, /\.terminal-ui \.network-panel \{ grid-area: network;/);
  assert.match(css, /\.terminal-ui \.record-panel, \.terminal-ui \.room-panel, \.terminal-ui \.network-panel \{ align-self: stretch; \}/);
  assert.match(css, /\.terminal-ui \.storage-panel \{ align-self: start; \}/);
  assert.match(css, /\.terminal-ui \.network-heading \.terminal-section-code \{[^}]*color: var\(--teal\);/);
  const networkHeadingStyle = css.match(/\.terminal-ui \.network-heading \{([^}]*)\}/)?.[1] ?? '';
  const remoteAudioRowStyle = css.match(/\.remote-audio-row \{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(networkHeadingStyle, /border-bottom/);
  assert.doesNotMatch(remoteAudioRowStyle, /border-top/);
  assert.match(css, /\.terminal-ui \.storage-panel \.terminal-section-code \{[^}]*color: var\(--teal\);/);
  assert.match(css, /\.terminal-ui \.setup-panel \.panel-heading::before \{[^}]*color: var\(--teal\);/);
  assert.match(css, /\.terminal-ui \.terminal-breadcrumb \{[^}]*color: var\(--teal\);/);
  assert.match(css, /\.terminal-ui \.terminal-section-code \{[^}]*color: var\(--teal\);/);
  assert.match(css, /\.transfer-progress \{[^}]*padding: 0;[^}]*border: 0;[^}]*background: transparent;/);
  assert.match(css, /\.terminal-ui \.network-metrics \{ font-size: 11px; line-height: 1\.35; \}/);
  const roomPanel = recorder.slice(invite, network);
  assert.match(roomPanel, /class="room-heading-right">[\s\S]*id="recordingReadiness" class="ready-badge off" role="status" aria-label="Not ready to record">READY/);
  assert.doesNotMatch(roomPanel, /roomGuestCount|roomGuestCapacity|room-state-badges/);
  assert.doesNotMatch(recorder, /id="transferProgressBar"|<progress\b/);
  assert.match(recorder, /Remaining \/ Total/);
  assert.match(readPrototype('room-call.js'), /setReadyBadge\(connected && this\.canStartRecording\)/);
  assert.doesNotMatch(roomPanel, /id="checkReadinessButton"|id="retryTransferButton"/);
  assert.match(roomPanel, /id="leaveRoomButton"[^>]*>End Call<\/button>/);
  assert.match(css, /\.terminal-ui \.waveform-panel \{ grid-area: wave;/);
  assert.match(css, /\.terminal-ui \.storage-panel \{ grid-area: storage;/);
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*?\.terminal-ui \.studio-grid \{ grid-template-columns: 1fr; grid-template-areas: "record" "room" "network" "wave" "storage"; \}/);
});

test('places the ON AIR badge at the capture panel top right and removes media detail labels', () => {
  const recordPanel = recorder.slice(recorder.indexOf('class="panel record-panel"'), recorder.indexOf('id="roomPanel"'));
  assert.match(recordPanel, /class="capture-heading-right">[\s\S]*id="captureStatusBadge"/);
  assert.match(recordPanel, /<span>ON AIR<\/span>/);
  for (const label of ['24-bit / 48 kHz WAV', 'Opus · mono · up to 32 kbps', '60 SEC / PER-PARTICIPANT']) {
    assert.equal(recorder.includes(label), false);
  }
  for (const title of ['ROOM LINK', 'NETWORK', 'TRACK MONITOR']) {
    assert.ok(recorder.includes(`class="terminal-section-code">${title}</span>`));
  }
  assert.doesNotMatch(recorder, /class="terminal-section-code">0[1-5]\s*\/\/|00\s*\/\/ INITIALIZE/);
  assert.doesNotMatch(readPrototype('recorder.css'), /\.record-panel::after/);
  assert.match(readPrototype('recorder.css'), /\.capture-heading \{[^}]*justify-content: space-between;/);
  assert.match(readPrototype('recorder.css'), /\.capture-heading \{[^}]*align-items: flex-start;/);
  assert.match(readPrototype('recorder.css'), /\.terminal-ui \.room-heading \{ align-items: start;/);
  assert.match(readPrototype('recorder.css'), /\.terminal-ui \.onair-badge, \.terminal-ui \.ready-badge \{ transform: translateY\(-4px\); \}/);
});

test('blinks the ON AIR indicator during startup and lights it on actual recording start', () => {
  const source = readPrototype('recorder.js');
  const updateBadge = source.slice(source.indexOf('function updateCaptureStatusBadge()'), source.indexOf('\nfunction setStatus'));
  const startRecording = source.slice(source.indexOf('async function startRecording('), source.indexOf('\nfunction applyHostRecordingState'));
  const startedHandler = source.slice(source.indexOf("if (data.type === 'started')"), source.indexOf("if (data.type === 'level')"));
  assert.match(updateBadge, /const isPending = !isOnAir && !recordingController\.snapshot\.finalizing && \(recordingController\.snapshot\.pending \|\| recordingController\.snapshot\.starting\)/);
  assert.match(updateBadge, /badge\.classList\.toggle\('pending', isPending\)/);
  assert.match(startedHandler, /recordingController\.captured\(operation\)/);
  assert.match(readPrototype('recorder.css'), /\.onair-badge\.pending \.onair-light[^}]*animation: onair-blink/);
});

test('formats transfer progress as remaining bytes, total bytes, and completion percentage', () => {
  const source = readPrototype('recorder.js');
  const start = source.indexOf('function formatTransferMegabytes(');
  const end = source.indexOf('\nfunction drawTransferGraph(', start);
  const context = {};
  runInNewContext(`${source.slice(start, end)}\nglobalThis.formatTransferRatio = formatTransferRatio;`, context);

  assert.equal(context.formatTransferRatio(1_000_000, 4_000_000), '1.00 MB / 4.00 MB · 75% complete');
  assert.equal(context.formatTransferRatio(0, 4_000_000), '0.00 MB / 4.00 MB · 100% complete');
  assert.equal(context.formatTransferRatio(9_000_000, 4_000_000), '4.00 MB / 4.00 MB · 0% complete');
  assert.equal(context.formatTransferRatio(0, 0), '0.00 MB / 0.00 MB · — complete');
});

test('plots saved-audio completion on a percentage axis at the right of the transfer graph', () => {
  const source = readPrototype('recorder.js');
  const start = source.indexOf('function drawTransferGraph(');
  const end = source.indexOf('\nasync function updateTransferProgress(', start);
  const labels = [];
  const strokes = [];
  let path = [];
  const canvasContext = {
    clearRect() {},
    setLineDash() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    stroke() { strokes.push({ color: this.strokeStyle, points: [...path] }); },
    fillText(text, x, y) { labels.push({ text, x, y, align: this.textAlign || 'left' }); }
  };
  const summary = {};
  const uploadSummary = { textContent: '' };
  const saveRateSummary = { textContent: '' };
  Object.defineProperty(summary, 'textContent', {
    get: () => `${uploadSummary.textContent} · ${saveRateSummary.textContent}`
  });
  const context = {
    transferGraphSamples: [],
    $: (id) => id === 'transferGraph'
      ? { width: 600, height: 96, getContext: () => canvasContext }
      : id === 'transferUploadSummary'
        ? uploadSummary
        : id === 'transferSaveRateSummary'
          ? saveRateSummary
      : summary
  };
  runInNewContext(source.slice(start, end), context);
  context.updateTransferGraph(60_000, 1.2, 75);

  assert.ok(labels.some(({ text, x, align }) => text === '100%' && x === 598 && align === 'right'));
  assert.ok(labels.some(({ text }) => text === '1.5 Mbps'));
  assert.deepEqual(strokes.find(({ color }) => color === '#82aaff').points, [[562, 25]]);
  assert.equal(summary.textContent, 'Upload 1.20 Mbps · Save Rate 75%');
});

test('uses readable text sizes throughout the session screen', () => {
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.button \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.ready-badge \{[^}]*font-size: 12px;/);
  assert.match(css, /\.terminal-ui \.onair-badge \{[^}]*font-size: 12px;/);
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

test('matches the Detect Devices button height to the microphone selector', () => {
  const css = readPrototype('recorder.css');
  assert.match(css, /\.terminal-ui \.device-row \.field select, \.terminal-ui \.device-row \.device-action \{ height: 42px; \}/);
});

test('places the guest join name above the approval and decline buttons', () => {
  const css = readPrototype('recorder.css');
  assert.match(css, /\.guest-request-card \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.guest-request-actions \{[^}]*justify-content: start;/);
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
  const stopRecording = source.slice(source.indexOf('function stopRecording('), source.indexOf('\nfunction audioContextTimeAtPerformanceTime'));
  assert.doesNotMatch(openSession, /drawWaveform\(\)/);
  assert.match(drawWaveform, /if \(!recordingController\.snapshot\.recording\) return/);
  assert.doesNotMatch(drawWaveform, /previewAnalyserNode|previewSamples/);
  assert.match(startHandler, /drawWaveform\(\)/);
  assert.match(stopRecording, /stopWaveformRendering\(\)/);
  assert.match(stopRecording, /appendNetworkEvent\(\s*'Recording stop local'/);

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
      assert.equal(elements.get('roleBadge').textContent, inviteMode ? 'Guest' : 'Host');
      assert.equal(elements.get('recentPanel').hidden, false);
    }
    assert.match(elements.get('statusMessage').textContent, /invitation link is invalid/i);
    assert.equal(elements.get('openStudioButton').disabled, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
