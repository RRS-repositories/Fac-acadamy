// Where to go after sign-in. Only same-origin paths are allowed, so a crafted
// ?next= link can't send someone to another site.
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return '/';
  return raw;
}
