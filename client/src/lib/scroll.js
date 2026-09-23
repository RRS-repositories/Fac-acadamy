import { useEffect } from 'react';

/*
 * Scroll rule (ported from the prototype, which sets `_scrollTop` in its
 * navigation actions only):
 *  - Navigation (moving to another page, stage, lesson, quiz or quiz attempt)
 *    scrolls to top.
 *  - In-place interactions (selecting an answer, marking a lesson read,
 *    opening a replica tab, filtering the status list, rendering the graded
 *    result) never scroll. Do not call scrollToTop() from those handlers.
 */
export function scrollToTop() {
  if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  } catch {
    // jsdom and some older browsers do not implement scrollTo options.
  }
}

/**
 * Scrolls to the top whenever `key` changes — the navigation half of the rule
 * for moves that a component owns (lesson → lesson, quiz attempt → retake).
 * `key` must be a primitive: it is compared by identity.
 */
export function useScrollToTopOnChange(key) {
  useEffect(() => {
    scrollToTop();
  }, [key]);
}

/**
 * Move focus without the browser scrolling the element into view. Used by the
 * in-place updates, where moving focus is right for a screen reader but moving
 * the page is not.
 */
export function focusWithoutScrolling(element) {
  if (!element || typeof element.focus !== 'function') return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Older browsers ignore the options object; focus() alone still works.
    element.focus();
  }
}
