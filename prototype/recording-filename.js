export function makeRecordingFilename(session, take, extension = 'wav') {
  const safeName = session.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'recording';
  const participantName = take.participant?.trim() || session.participant?.trim() || 'participant';
  const safeParticipant = participantName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
  const date = new Date(take.startedAt).toISOString().slice(0, 10);
  const recoveryTag = take.status === 'recovered' ? '_recovered' : '';
  return `${safeName}_${safeParticipant}_take-${String(take.number).padStart(2, '0')}${recoveryTag}_${date}.${extension}`;
}
