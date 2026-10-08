const PROFILE_KEY = 'perfectpodcast-host-profile';

export function profileDisplayName(profile, sub) {
  if (!profile || profile.sub !== sub) return '';
  for (const value of [profile.name, profile.nickname]) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return '';
}

export function saveHostProfile(storage, profile, sub) {
  const name = profileDisplayName(profile, sub);
  if (name) storage.setItem(PROFILE_KEY, JSON.stringify({ sub, name }));
  else storage.removeItem(PROFILE_KEY);
  return name;
}

export function readHostProfile(storage, sub) {
  try {
    return profileDisplayName(JSON.parse(storage.getItem(PROFILE_KEY)), sub);
  } catch {
    return '';
  }
}

export function clearHostProfile(storage) {
  storage.removeItem(PROFILE_KEY);
}
