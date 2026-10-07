import { createAuth0Client } from '@auth0/auth0-spa-js';

let clientPromise;
let configPromise;

export async function loadAuth0Config() {
  configPromise ||= fetch('/auth/config', { cache: 'no-store' }).then(async (response) => {
    const config = await response.json();
    if (!response.ok) throw new Error(config.message || 'Auth0設定を読み込めません。');
    return config;
  });
  return configPromise;
}

export async function getAuth0Client() {
  clientPromise ||= loadAuth0Config().then((config) => createAuth0Client({
    domain: config.domain,
    clientId: config.clientId,
    cacheLocation: 'memory',
    authorizationParams: {
      redirect_uri: `${window.location.origin}/index.html`,
      audience: config.audience,
      scope: `openid profile email ${config.hostPermission}`
    }
  }));
  return clientPromise;
}

export async function getHostSession() {
  const response = await fetch('/auth/session', {
    cache: 'no-store',
    credentials: 'same-origin'
  });
  const payload = await response.json();
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(payload.message || 'ホスト認証を確認できません。');
  return payload;
}

export async function establishHostSession(client) {
  const accessToken = await client.getTokenSilently();
  const response = await fetch('/auth/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'ホスト認証を確立できません。');
  return payload;
}

export async function signOut(client) {
  const response = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('アプリのログイン状態を終了できません。');
  await client.logout({
    logoutParams: { returnTo: `${window.location.origin}/index.html?logout=1` }
  });
}

export function safeReturnTo(value) {
  const allowedPaths = new Set(['/recorder.html', '/turn-test.html']);
  if (typeof value !== 'string') return '/recorder.html';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !allowedPaths.has(url.pathname)) {
      return '/recorder.html';
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/recorder.html';
  }
}
