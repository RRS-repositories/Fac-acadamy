import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { focusWithoutScrolling, scrollToTop, useScrollToTopOnChange } from '../src/lib/scroll.js';

/*
 * The scroll rule in one place: navigation scrolls to the top, in-place
 * updates never move the page.
 */

afterEach(() => {
  vi.restoreAllMocks();
  window.scrollTo = () => {};
});

describe('scrollToTop', () => {
  it('asks the window for the top of the page', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo');
    scrollToTop();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('survives a window that does not implement scrollTo options', () => {
    window.scrollTo = () => {
      throw new TypeError('not implemented');
    };
    expect(() => scrollToTop()).not.toThrow();
  });
});

describe('useScrollToTopOnChange', () => {
  it('scrolls on mount and on every change of the key, but not on a re-render', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo');
    const { rerender } = renderHook(({ key }) => useScrollToTopOnChange(key), {
      initialProps: { key: 'lesson-1' },
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender({ key: 'lesson-1' });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender({ key: 'lesson-2' });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe('focusWithoutScrolling', () => {
  it('focuses with preventScroll so the page stays where it is', () => {
    const element = document.createElement('button');
    document.body.appendChild(element);
    const focus = vi.spyOn(element, 'focus');

    focusWithoutScrolling(element);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    element.remove();
  });

  it('ignores a missing element', () => {
    expect(() => focusWithoutScrolling(null)).not.toThrow();
  });
});
