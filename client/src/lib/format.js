import { TRACKS } from '@fac-academy/shared';

/*
 * Small display helpers for the management screens. Formatting only — no
 * training content, no rules, no decisions the server already made.
 */

/** "Customer Service" for 'CS'; the code itself if it is not one of the nine. */
export function trackLabel(code) {
  if (!code) return 'No track yet';
  return TRACKS.find((t) => t.code === code)?.label ?? code;
}

/** Whole days between an ISO timestamp and now. Null when there is no date. */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * "just now", "12 min ago", "3 hours ago", "9 days ago" — the manager reads
 * these at a glance, so they stay coarse and plain.
 */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** "84%" or "—" when nobody has sat a quiz yet. */
export function percent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value))}%`;
}

/** A day + month + year a manager can read: "23 Sep 2026". */
export function shortDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Waiting for track" from 'waiting_for_track' — the server owns the value. */
export function humanStatus(status) {
  const text = String(status ?? '').trim();
  if (text === '') return 'Unknown';
  const spaced = text.replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
