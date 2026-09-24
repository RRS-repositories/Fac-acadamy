// Track codes, roles and the pass-mark rule. Mirrors the prototype exactly.
// No training content or answers belong here: this file ships to the browser.

export const TRACKS = [
  { code: 'FULL', label: 'Full Programme' },
  { code: 'CS', label: 'Customer Service' },
  { code: 'SALES', label: 'Sales' },
  { code: 'ADMIN', label: 'Admin' },
  { code: 'FOS', label: 'Financial Ombudsman' },
  { code: 'MGMT', label: 'Management' },
  { code: 'PAY', label: 'Payments' },
  { code: 'IT', label: 'IT' },
  { code: 'DEBT', label: 'Debt Collections' },
] as const;

export type TrackCode = (typeof TRACKS)[number]['code'];

export const TRACK_CODES: readonly TrackCode[] = TRACKS.map((t) => t.code);

export const ROLES = ['STAFF', 'MANAGER'] as const;

export type Role = (typeof ROLES)[number];

export const DEFAULT_PASS_MARK = 80;

/** Whole-number percentage, rounded the same way as the prototype. */
export function scorePercent(correct: number, total: number): number {
  if (total <= 0) {
    throw new RangeError('scorePercent: total must be greater than 0');
  }
  return Math.round((correct / total) * 100);
}

export function isPass(pct: number, passMark: number): boolean {
  return pct >= passMark;
}
