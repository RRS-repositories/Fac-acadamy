import { readLesson } from '../helpers/api.js';
import { lessonIdsForStage } from '../helpers/db.js';
import { expect, test } from '../helpers/test.js';

// 4 and 5. THE TWO MOVEMENT RULES.
//
//   * Choosing a quiz answer must never move the page. The option rows are
//     drawn so that picking one does not change any element's size, because a
//     page that jumps under the pointer makes people mis-click on a test.
//   * Moving from one lesson to the next must go back to the top, so the next
//     lesson starts at its first line and not halfway down.
//   * With `prefers-reduced-motion: reduce`, the "next up" pulse must not
//     animate. The control test below runs the same assertion with motion
//     allowed and expects the animation to BE there, so a passing
//     reduced-motion test cannot just mean the selector found nothing.

const STAGE = 's1';

test.describe('scroll rules', () => {
  test('selecting a quiz answer never moves the page', async ({ staff }) => {
    await staff.reset('CS');
    // A short viewport, so there is something to scroll.
    const page = await staff.open({ viewport: { width: 900, height: 600 } });
    for (const lessonId of await lessonIdsForStage(STAGE)) {
      expect(await readLesson(page, lessonId)).toBe(204);
    }

    await page.goto(`/stage/${STAGE}/quiz`);
    const cards = page.getByTestId('question-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(1);

    await page.evaluate(() => {
      window.scrollTo(0, 250);
    });
    expect(
      await page.evaluate(() => window.scrollY),
      'the quiz page must be long enough to scroll',
    ).toBeGreaterThan(100);

    // Playwright scrolls an element into view before it clicks it, which would
    // move the page by itself. So each option is brought into view FIRST, the
    // position is read AFTER that, and only then is the option chosen: what is
    // measured is the click, not the scrolling the test did.
    const count = await cards.count();
    let scrolledSomewhere = false;
    for (let i = 0; i < count; i += 1) {
      const option = cards.nth(i).getByRole('radio').first();
      await option.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      if (before > 0) scrolledSomewhere = true;
      await option.check();
      await expect(option).toBeChecked();
      expect(
        await page.evaluate(() => window.scrollY),
        `answering question ${String(i + 1)} moved the page`,
      ).toBe(before);
    }
    expect(scrolledSomewhere, 'the page was scrolled while answering').toBe(true);
    await page.context().close();
  });

  test('moving between lessons scrolls back to the top', async ({ staff, staffPage }) => {
    await staff.reset('CS');
    const lessons = await lessonIdsForStage(STAGE);
    expect(lessons.length).toBeGreaterThan(1);

    await staffPage.setViewportSize({ width: 900, height: 600 });
    await staffPage.goto(`/stage/${STAGE}/lesson/${String(lessons[0]!)}`);
    await expect(staffPage.getByRole('button', { name: /Mark lesson complete/ })).toBeVisible();

    await staffPage.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    expect(await staffPage.evaluate(() => window.scrollY)).toBeGreaterThan(50);

    await staffPage
      .getByRole('navigation', { name: 'Lessons in this stage' })
      .getByRole('link')
      .nth(1)
      .click();
    await staffPage.waitForURL(`**/lesson/${String(lessons[1]!)}`);
    await expect(staffPage.getByRole('button', { name: /Mark lesson complete/ })).toBeVisible();
    await expect
      .poll(async () => staffPage.evaluate(() => window.scrollY), { timeout: 5_000 })
      .toBe(0);
  });
});

test.describe('reduced motion', () => {
  test('the next-up pulse does not animate when reduced motion is asked for', async ({ staff }) => {
    await staff.reset('CS');
    const page = await staff.open({ reducedMotion: 'reduce' });
    await page.goto('/');
    const pulse = page.locator('[data-pulse="next-up"]').first();
    await expect(pulse).toBeVisible();
    // The element and its class are still there: the media query kills the
    // animation itself, which is what has to be checked.
    await expect(pulse).toHaveClass(/animate-pulse-glow/);
    const animation = await pulse.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation, 'the pulse must not animate under prefers-reduced-motion').toBe('none');
    await page.context().close();
  });

  test('...and it does animate when motion is allowed (the control)', async ({ staff }) => {
    await staff.reset('CS');
    const page = await staff.open({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const pulse = page.locator('[data-pulse="next-up"]').first();
    await expect(pulse).toBeVisible();
    const animation = await pulse.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation, 'without the preference the pulse animates').not.toBe('none');
    await page.context().close();
  });
});
