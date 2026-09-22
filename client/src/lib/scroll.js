/*
 * Scroll rule:
 *  - Navigation (moving to another page, stage, lesson or quiz) scrolls to top.
 *  - In-place interactions (selecting an answer, opening a panel, toggling a
 *    control) never scroll. Do not call scrollToTop() from those handlers.
 */
export function scrollToTop() {
  if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  } catch {
    // jsdom and some older browsers do not implement scrollTo options.
  }
}
