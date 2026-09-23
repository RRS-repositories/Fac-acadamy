import { stageCodes } from '../helpers/api.js';
import { TRACKS, expectedStages } from '../helpers/expected.js';
import { expect, test } from '../helpers/test.js';

// 1. NINE TRACKS.
//
// For every track: put the account on it, open the dashboard as a signed-in
// trainee, and assert the stages it shows are EXACTLY the ones
// ops/fixtures/expected-track-visibility.json lists, in that order — the
// unlock order. The fixture was typed by hand from PROJECT-PLAN §1, so it is
// an oracle and not a second opinion from the same code.
//
// The stage codes never appear as text on the dashboard (the cards read
// "Stage 4 — Customer Service Excellence"); they are on the card element as
// `data-stage`, which is what this reads.
//
// Only the mock CRM's invented accounts can sign in, and none of them is
// per-track, so one leased account is moved from track to track. Each move is
// a fresh start: no progress, so the first stage is open and the rest are
// locked, which is asserted too — a list of the right length with everything
// unlocked would be a different bug.

test.describe('nine tracks see exactly their own stages', () => {
  for (const track of TRACKS) {
    test(`${track}: the dashboard lists the expected stages, in order`, async ({
      staff,
      staffPage,
    }) => {
      const expected = expectedStages(track);
      await staff.reset(track);

      await staffPage.goto('/');
      await expect(staffPage.getByRole('heading', { level: 1 })).toBeVisible();

      const shown = await staffPage
        .locator('[data-stage]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-stage') ?? ''));
      expect(shown, `dashboard stage list for ${track}`).toEqual(expected);

      // The API the page was built from must agree, in the same order.
      expect(await stageCodes(staffPage), `GET /api/track for ${track}`).toEqual(expected);

      // Day one: the first stage is open, every later one is locked.
      const states = await staffPage
        .locator('[data-stage]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-state') ?? ''));
      expect(states[0]).toBe('available');
      expect(states.slice(1).every((s) => s === 'locked')).toBe(true);
    });
  }
});
