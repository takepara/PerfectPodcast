export function monitorRecordingTrack(track, {
  isRecording,
  onMuted,
  onUnmuted,
  onEnded,
  onMuteTimeout
}, muteGraceMs = 5_000) {
  if (!track || typeof track.addEventListener !== 'function' ||
      typeof track.removeEventListener !== 'function' ||
      typeof isRecording !== 'function' || typeof onMuted !== 'function' ||
      typeof onUnmuted !== 'function' || typeof onEnded !== 'function' ||
      typeof onMuteTimeout !== 'function' ||
      !Number.isSafeInteger(muteGraceMs) || muteGraceMs < 0) {
    throw new Error('The microphone input monitoring configuration is invalid.');
  }

  let muteTimer = null;
  const handleMute = () => {
    if (!isRecording()) return;
    onMuted();
    clearTimeout(muteTimer);
    muteTimer = setTimeout(() => {
      muteTimer = null;
      if (isRecording() && track.muted) onMuteTimeout();
    }, muteGraceMs);
  };
  const handleUnmute = () => {
    clearTimeout(muteTimer);
    muteTimer = null;
    if (isRecording()) onUnmuted();
  };
  const handleEnded = () => {
    if (isRecording()) onEnded();
  };
  const cleanup = () => {
    clearTimeout(muteTimer);
    muteTimer = null;
    track.removeEventListener('mute', handleMute);
    track.removeEventListener('unmute', handleUnmute);
    track.removeEventListener('ended', handleEnded);
  };

  track.addEventListener('mute', handleMute);
  track.addEventListener('unmute', handleUnmute);
  track.addEventListener('ended', handleEnded);
  return {
    checkCurrentMute() {
      if (track.muted) handleMute();
    },
    cleanup
  };
}
