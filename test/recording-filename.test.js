import assert from 'node:assert/strict';
import test from 'node:test';
import { makeRecordingFilename } from '../prototype/recording-filename.js';

const session = {
  name: '収録 10/07',
  participant: 'Host User'
};

test('includes the local host participant name, including for older takes', () => {
  assert.equal(
    makeRecordingFilename(session, {
      number: 1,
      startedAt: Date.UTC(2026, 9, 7),
      status: 'stopped'
    }),
    '収録_10_07_Host_User_take-01_2026-10-07.wav'
  );
});

test('uses the remote participant name for guest recordings', () => {
  assert.equal(
    makeRecordingFilename(session, {
      number: 2,
      participant: 'Guest Name',
      startedAt: Date.UTC(2026, 9, 7),
      status: 'recovered'
    }),
    '収録_10_07_Guest_Name_take-02_recovered_2026-10-07.wav'
  );
});
