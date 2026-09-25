// The full-page screen shown before we know who the visitor is.
//
// It used to be the word "Loading…" as a heading in the top-left corner, which
// on a fast connection flashes up and reads as a page that failed to render.
// It is now a spinner in the middle of the screen. These tests hold the two
// things that matter: it is still announced to a screen reader, and someone who
// has asked for reduced motion is not left with a ring that does not turn.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuthStatusScreen from '../src/components/AuthStatusScreen.jsx';

describe('AuthStatusScreen', () => {
  describe('while loading', () => {
    it('centres a spinner on the page instead of a heading', () => {
      render(<AuthStatusScreen title="Loading…" busy />);
      const page = screen.getByTestId('full-page-loading');
      expect(page).toHaveAttribute('aria-busy', 'true');
      expect(page.className).toContain('items-center');
      expect(page.className).toContain('justify-center');
      expect(page.className).toContain('min-h-screen');
      // No heading: the old top-left "Loading…" is what we are replacing.
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });

    it('still announces itself, and still says the words', () => {
      render(<AuthStatusScreen title="Loading…" busy />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      // Present for a screen reader even though it is visually hidden.
      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    it('spins, and drops the spinner under reduced motion so the words show', () => {
      const { container } = render(<AuthStatusScreen title="Loading…" busy />);
      const ring = container.querySelector('[aria-hidden="true"]');
      expect(ring).not.toBeNull();
      expect(ring.className).toContain('animate-spin');
      // Reduced motion: hide the ring, un-hide the wording.
      expect(ring.className).toContain('motion-reduce:hidden');
      expect(screen.getByText('Loading…').className).toContain('motion-reduce:not-sr-only');
    });

    it('shows no message or button, however they are passed', () => {
      render(
        <AuthStatusScreen
          title="Loading…"
          busy
          message="should not appear"
          action={{ label: 'should not appear either', onClick: () => {} }}
        />,
      );
      expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('when it is not loading', () => {
    it('still shows the heading, the message and the button', () => {
      render(
        <AuthStatusScreen
          title="We couldn't check your sign-in."
          message="Please try again shortly."
          action={{ label: 'Try again', onClick: () => {} }}
        />,
      );
      expect(
        screen.getByRole('heading', { name: "We couldn't check your sign-in." }),
      ).toBeInTheDocument();
      expect(screen.getByText('Please try again shortly.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.queryByTestId('full-page-loading')).not.toBeInTheDocument();
    });
  });
});
