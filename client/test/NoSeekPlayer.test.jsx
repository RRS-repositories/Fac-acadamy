import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NoSeekPlayer from '../src/components/training/NoSeekPlayer.jsx';
import { callsTo, mockFetch } from './helpers.jsx';

/*
 * The no-seek player. All invented: a thirty-second "recording" with a made-up
 * title. Nothing real, and no audio — jsdom has no media engine, so play,
 * pause and currentTime are stubbed and the media events are fired by hand,
 * exactly as a browser would fire them.
 *
 * What these tests are really checking is the promise in the prototype: there
 * is nothing to scrub with, a jump forward buys nothing, and the badge is the
 * server's answer rather than the player's opinion.
 */

const RECORDING = {
  id: 21,
  title: 'Test recording one',
  description: 'An invented example.',
  durationSecs: 30,
  mediaType: 'AUDIO',
  comingSoon: false,
  listened: false,
};

const PROGRESS_PATH = '/api/media/21/progress';

/**
 * The server's answer to a beacon, in the ordinary case where it counted
 * everything it was sent: `acceptedTo` is then the furthest second of the
 * request. It is computed from the request rather than hard-coded, because the
 * player uses it to decide what it still owes.
 */
function progress(listened, coveredSecs) {
  return (init) => {
    const { intervals } = JSON.parse(init.body);
    const acceptedTo = Math.max(...intervals.map(([, to]) => to));
    return [200, { listened, coveredSecs, durationSecs: 30, requiredSecs: 28, acceptedTo }];
  };
}

/** Give jsdom's media elements just enough behaviour to drive the player. */
beforeAll(() => {
  const proto = window.HTMLMediaElement.prototype;
  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get() {
      return this._paused !== false;
    },
  });
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get() {
      return this._time ?? 0;
    },
    set(value) {
      this._time = value;
    },
  });
  proto.play = function play() {
    this._paused = false;
    fireEvent.play(this);
    return Promise.resolve();
  };
  proto.pause = function pause() {
    this._paused = true;
    fireEvent.pause(this);
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderPlayer(recording = RECORDING) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ul>
        <NoSeekPlayer recording={recording} stageCode="a2" />
      </ul>
    </QueryClientProvider>,
  );
  return document.querySelector('[data-testid="media-21"]');
}

/** Move playback on the way a browser does: set the clock, then fire the event. */
function playTo(media, seconds) {
  media.currentTime = seconds;
  fireEvent.timeUpdate(media);
}

/** The intervals of the most recent beacon. */
function lastIntervals(fetchMock) {
  const calls = callsTo(fetchMock, 'POST', PROGRESS_PATH);
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1][1].body).intervals;
}

describe('NoSeekPlayer', () => {
  it('offers play/pause and nothing to seek with', () => {
    mockFetch();
    const media = renderPlayer();

    // No native controls means no scrub bar, and there is no slider of our own.
    expect(media.hasAttribute('controls')).toBe(false);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(media.getAttribute('controlsList')).toBe('nodownload noplaybackrate');
    expect(media.getAttribute('src')).toBe('/api/media/21/stream');

    // The one control is a real button, so it is reachable from the keyboard.
    const button = screen.getByRole('button', { name: /play Test recording one/i });
    expect(button.tagName).toBe('BUTTON');
  });

  it('sends what it played when playback is paused', async () => {
    const fetchMock = mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(false, 6) });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    playTo(media, 3);
    playTo(media, 6);
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));

    await vi.waitFor(() => {
      expect(callsTo(fetchMock, 'POST', PROGRESS_PATH)).toHaveLength(1);
    });
    expect(lastIntervals(fetchMock)).toEqual([[0, 6]]);
  });

  it('beacons while it is playing, without waiting for a pause', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(false, 4) });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    playTo(media, 4);
    expect(callsTo(fetchMock, 'POST', PROGRESS_PATH)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callsTo(fetchMock, 'POST', PROGRESS_PATH)).toHaveLength(1);
    expect(lastIntervals(fetchMock)).toEqual([[0, 4]]);
  });

  it('sends again the seconds the server did not count, and only those', async () => {
    // The server credits a beacon against the wall clock and shortens the
    // interval that runs out of it, answering with how far it got. Anything
    // above that is still owed: if the player restarts from what it SENT, the
    // tail is never counted again and the coverage keeps a hole — the defect of
    // 25 Sep 2026, where two full listens were credited about half.
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = mockFetch({
      [`POST ${PROGRESS_PATH}`]: (init) => {
        call += 1;
        const { intervals } = JSON.parse(init.body);
        const highest = Math.max(...intervals.map(([, to]) => to));
        // The first beacon is trimmed to two seconds; later ones are accepted.
        const acceptedTo = call === 1 ? 2 : highest;
        return [
          200,
          {
            listened: false,
            coveredSecs: acceptedTo,
            durationSecs: 30,
            requiredSecs: 28,
            acceptedTo,
          },
        ];
      },
    });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    playTo(media, 4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastIntervals(fetchMock)).toEqual([[0, 4]]);

    playTo(media, 8);
    await vi.advanceTimersByTimeAsync(5_000);
    // 2–4 was refused, so it goes again beside what has been played since.
    expect(lastIntervals(fetchMock)).toEqual([
      [2, 4],
      [4, 8],
    ]);

    // That beacon was accepted in full, so the next one carries the new stretch
    // and nothing else: an accepted second is never sent twice.
    playTo(media, 12);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastIntervals(fetchMock)).toEqual([[8, 12]]);
  });

  it('shows the badge the server sent, not the one playback suggests', async () => {
    // Playback reaches the end, but the server has not accepted it as a full
    // listen. The badge must not claim otherwise.
    const fetchMock = mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(false, 5) });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    for (const at of [5, 10, 15, 20, 25, 30]) playTo(media, at);
    fireEvent.ended(media);

    await vi.waitFor(() => {
      expect(callsTo(fetchMock, 'POST', PROGRESS_PATH)).toHaveLength(1);
    });
    expect(screen.getByText('To listen')).toBeInTheDocument();
    expect(screen.queryByText('Listened ✓')).toBeNull();
  });

  it('shows "Listened ✓" as soon as the server says so', async () => {
    const fetchMock = mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(true, 30) });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    for (const at of [5, 10, 15, 20, 25, 30]) playTo(media, at);
    fireEvent.ended(media);

    await vi.waitFor(() => {
      expect(callsTo(fetchMock, 'POST', PROGRESS_PATH)).toHaveLength(1);
    });
    expect(await screen.findByText('Listened ✓')).toBeInTheDocument();
  });

  it('starts from the server state when the stage says it is already done', () => {
    mockFetch();
    renderPlayer({ ...RECORDING, listened: true });
    expect(screen.getByText('Listened ✓')).toBeInTheDocument();
  });

  it('snaps a jump forward back, and never reports the part that was skipped', async () => {
    const fetchMock = mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(false, 4) });
    const media = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    playTo(media, 4);

    // Something outside this UI moves the position to the end.
    media.currentTime = 29;
    fireEvent.seeking(media);
    expect(media.currentTime).toBe(4);

    fireEvent.seeked(media);
    playTo(media, 5);
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));

    await vi.waitFor(() => {
      expect(callsTo(fetchMock, 'POST', PROGRESS_PATH).length).toBeGreaterThan(0);
    });
    const sent = callsTo(fetchMock, 'POST', PROGRESS_PATH).flatMap(
      ([, init]) => JSON.parse(init.body).intervals,
    );
    // Everything reported stays inside what was actually played.
    for (const [from, to] of sent) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThanOrEqual(5);
    }
  });

  it('uses a <video> element for a screen recording', () => {
    mockFetch();
    const media = renderPlayer({ ...RECORDING, mediaType: 'VIDEO', title: 'Test walkthrough' });
    expect(media.tagName).toBe('VIDEO');
    expect(screen.getByText('To watch')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
