const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ALLOWED_MESSAGES = {
  host: new Set(['approved', 'denied', 'offer', 'auth-confirm', 'candidate', 'ice-restart']),
  guest: new Set(['join-request', 'answer', 'candidate', 'ice-restart-answer'])
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/signal/')) {
      const roomId = url.pathname.slice('/signal/'.length);
      if (request.method !== 'GET' || !ROOM_ID_PATTERN.test(roomId) ||
          request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Not found', { status: 404 });
      }
      const room = env.ROOMS.getByName(roomId);
      return room.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class RoomSignaling {
  constructor(state) {
    this.state = state;
    this.peers = new Map();
  }

  async fetch(request) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
      return new Response('Forbidden', { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener('message', (event) => { void this.onMessage(server, event); });
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(socket, event) {
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_MESSAGE_BYTES) {
      this.reject(socket, 'メッセージが大きすぎるか形式が不正です。');
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.reject(socket, 'メッセージ形式が不正です。');
      return;
    }
    if (!this.peers.has(socket)) {
      this.join(socket, message);
      return;
    }
    const role = this.peers.get(socket);
    if (!message || typeof message.type !== 'string' || !ALLOWED_MESSAGES[role].has(message.type)) {
      this.reject(socket, '許可されていないシグナリングメッセージです。');
      return;
    }
    const recipientRole = role === 'host' ? 'guest' : 'host';
    const recipient = [...this.peers].find(([, peerRole]) => peerRole === recipientRole)?.[0];
    if (recipient?.readyState === WebSocket.OPEN) {
      recipient.send(event.data);
    } else if (message.type !== 'denied') {
      this.reject(socket, '相手がシグナリングに接続していません。');
    }
  }

  join(socket, message) {
    if (!message || message.type !== 'join' || !['host', 'guest'].includes(message.role)) {
      this.reject(socket, '部屋への参加要求が不正です。');
      return;
    }
    const roles = [...this.peers.values()];
    if (message.role === 'host' && roles.includes('host')) {
      this.reject(socket, 'この部屋にはホストが既に接続しています。');
      return;
    }
    if (message.role === 'guest' && (!roles.includes('host') || roles.includes('guest'))) {
      this.reject(socket, 'この部屋は現在参加できません。');
      return;
    }
    this.peers.set(socket, message.role);
    socket.send(JSON.stringify({ type: 'joined' }));
  }

  reject(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'rejected', message }));
      socket.close(1008, 'Rejected');
    }
    this.onClose(socket);
  }

  onClose(socket) {
    const role = this.peers.get(socket);
    if (!role) return;
    this.peers.delete(socket);
    if (role === 'host') {
      for (const [peer, peerRole] of this.peers) {
        if (peerRole === 'guest') {
          this.peers.delete(peer);
          if (peer.readyState === WebSocket.OPEN) peer.close(1000, 'Host left');
        }
      }
      return;
    }
    const host = [...this.peers].find(([, peerRole]) => peerRole === 'host')?.[0];
    if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ type: 'peer-left' }));
  }
}
