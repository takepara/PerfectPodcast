import { Auth0Client } from '@auth0/auth0-spa-js';
import { clearHostProfile, readHostProfile, saveHostProfile } from './auth-profile.js';

let clientPromise;
let configPromise;

export async function loadAuth0Config() {
  configPromise ||= fetch('/auth/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  }).then(async (response) => {
    const config = await response.json();
    if (!response.ok) throw new Error(config.message || 'Unable to load Auth0 settings.');
    return config;
  });
  return configPromise;
}

export async function getAuth0Client() {
  clientPromise ||= loadAuth0Config().then((config) => new Auth0Client({
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
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json();
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(payload.message || 'Unable to verify host authentication.');
  return payload;
}

export async function establishHostSession(client) {
  const accessToken = await client.getTokenSilently();
  const response = await fetch('/auth/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Unable to establish host authentication.');
  try {
    saveHostProfile(window.sessionStorage, await client.getUser(), payload.sub);
  } catch {
    // Profile access must not prevent a successful login.
  }
  return payload;
}

export async function getHostDisplayName(session) {
  try {
    const storedName = readHostProfile(window.sessionStorage, session.sub);
    if (storedName) return storedName;
    const client = await getAuth0Client();
    await client.getTokenSilently();
    return saveHostProfile(window.sessionStorage, await client.getUser(), session.sub);
  } catch {
    return '';
  }
}

export async function signOut(client) {
  const response = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Unable to end the application session.');
  try {
    clearHostProfile(window.sessionStorage);
  } catch {
    // Storage may be unavailable even when logout succeeds.
  }
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
