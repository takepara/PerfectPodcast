export function turnPermitSigningMessage(payload) {
  return [
    'PerfectPodcast TURN room permit v1',
    payload.roomId,
    payload.hostKeyHash,
    String(payload.issuedAt),
    String(payload.expiresAt),
    payload.jti,
    String(payload.maxGuests)
  ].join('\n');
}
