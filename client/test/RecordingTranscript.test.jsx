import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NoSeekPlayer from '../src/components/training/NoSeekPlayer.jsx';
import { activeIndexAt, speakerName } from '../src/components/training/RecordingTranscript.jsx';
import { mockFetch } from './helpers.jsx';

/*
 * The transcript panel under the player.
 *
 * It is tested THROUGH NoSeekPlayer rather than on its own, because the thing
 * that matters most about it is not what it draws: it is that clicking a line
 * goes backwards and only backwards. That promise is kept by the panel and the
 * player together, so testing the panel alone would prove the wrong thing.
 *
 * All invented: a thirty-second "recording" with three made-up lines between two
 * made-up people. No audio — jsdom has no media engine, so currentTime is stubbed
 * and the media events are fired by hand, exactly as the NoSeekPlayer suite does.
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

const TRANSCRIPT_PATH = '/api/media/21/transcript';
const PROGRESS_PATH = '/api/media/21/progress';

const SEGMENTS = [
  { start: 0, end: 5, text: 'Good morning, this is Dana from the claims team.' },
  { start: 6, end: 10, text: 'Yes, speaking.' },
  { start: 12, end: 20, text: 'I am calling about the questionnaire we sent last week.' },
];
const TEXT = SEGMENTS.map((s) => s.text).join('\n');

function transcript(over = {}) {
  return { recordingId: 21, status: 'DONE', text: TEXT, segments: SEGMENTS, ...over };
}

function progress() {
  return (init) => {
    const { intervals } = JSON.parse(init.body);
    return [
      200,
      {
        listened: false,
        coveredSecs: 1,
        durationSecs: 30,
        requiredSecs: 28,
        acceptedTo: Math.max(...intervals.map(([, to]) => to)),
      },
    ];
  };
}

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
});

function renderPlayer(routes = {}) {
  mockFetch({ [`POST ${PROGRESS_PATH}`]: progress(), ...routes });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ul>
        <NoSeekPlayer recording={RECORDING} stageCode="a2" />
      </ul>
    </QueryClientProvider>,
  );
  return document.querySelector('[data-testid="media-21"]');
}

/** Move playback the way a browser does: set the clock, then fire the event. */
function playTo(media, seconds) {
  media.currentTime = seconds;
  fireEvent.timeUpdate(media);
}

const lines = () => [...document.querySelectorAll('button[data-line]')];
const activeLine = () => document.querySelector('button[data-active="true"]');

describe('activeIndexAt', () => {
  it('lights the line that has started, and keeps it lit through the pause after it', () => {
    // Whisper leaves gaps wherever nobody is speaking. A rule that needed
    // `position < end` would drop the highlight into nothing during every pause
    // and make it flicker through a call full of them.
    expect(activeIndexAt(SEGMENTS, 0)).toBe(0);
    expect(activeIndexAt(SEGMENTS, 4.9)).toBe(0);
    expect(activeIndexAt(SEGMENTS, 5.5)).toBe(0); // the gap between lines 1 and 2
    expect(activeIndexAt(SEGMENTS, 6)).toBe(1);
    expect(activeIndexAt(SEGMENTS, 19)).toBe(2);
    expect(activeIndexAt(SEGMENTS, 99)).toBe(2);
  });

  it('names the two channels neutrally, and admits when it cannot tell', () => {
    // Never 'Agent' and 'Client': which side the adviser sits on is a property of
    // the phone system, not of the audio, and it is not the same on every
    // recording we hold.
    expect(speakerName('A')).toBe('Speaker 1');
    expect(speakerName('B')).toBe('Speaker 2');
    expect(speakerName(undefined)).toBe('Speaker unclear');
    expect(speakerName('C')).toBe('Speaker unclear');
  });

  it('lights nothing before the first line starts', () => {
    expect(activeIndexAt([{ start: 3, end: 4, text: 'Later.' }], 1)).toBe(-1);
    expect(activeIndexAt([], 5)).toBe(-1);
    expect(activeIndexAt(SEGMENTS, Number.NaN)).toBe(-1);
  });
});

describe('the transcript panel', () => {
  it('shows the lines and follows the audio', async () => {
    const media = renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript()] });

    expect(await screen.findByText(/what was said on this call/i)).toBeTruthy();
    expect(lines()).toHaveLength(3);
    expect(screen.getByText('Yes, speaking.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /play Test recording one/i }));
    playTo(media, 1);
    expect(activeLine()?.dataset.line).toBe('0');

    playTo(media, 7);
    expect(activeLine()?.dataset.line).toBe('1');

    playTo(media, 15);
    expect(activeLine()?.dataset.line).toBe('2');
    // The line being spoken is what a screen reader is told is current.
    expect(activeLine()?.getAttribute('aria-current')).toBe('true');
  });

  it('seeks BACK when a line that has already been heard is clicked', async () => {
    const media = renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript()] });
    await screen.findByText(/what was said on this call/i);

    fireEvent.click(screen.getByRole('button', { name: /play Test recording one/i }));
    playTo(media, 15);
    expect(media.currentTime).toBe(15);

    // Reading a passage again is not cheating, and it is the whole point of the
    // panel being clickable at all.
    fireEvent.click(lines()[0]);
    expect(media.currentTime).toBe(0);
  });

  it('DOES NOT seek forward when a line that has not been reached is clicked', async () => {
    // The single most important thing in this file. The player forbids skipping
    // ahead — a full listen is what unlocks the stage quiz — so the transcript
    // must not become the way round it.
    const media = renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript()] });
    await screen.findByText(/what was said on this call/i);

    fireEvent.click(screen.getByRole('button', { name: /play Test recording one/i }));
    playTo(media, 7);
    expect(media.currentTime).toBe(7);

    // Line 3 starts at 12 seconds: eight seconds of the call have not been heard.
    const ahead = lines()[2];
    expect(ahead.disabled).toBe(true);
    fireEvent.click(ahead);
    expect(media.currentTime).toBe(7);

    // And the guard behind the disabled button: clicking it directly, the way an
    // extension or the console could, still moves nothing.
    ahead.disabled = false;
    fireEvent.click(ahead);
    expect(media.currentTime).toBe(7);

    // The line already heard is still clickable, so nothing was disabled wholesale.
    expect(lines()[0].disabled).toBe(false);
  });

  it('will not let the current line be used to jump to its own future', async () => {
    const media = renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript()] });
    await screen.findByText(/what was said on this call/i);

    fireEvent.click(screen.getByRole('button', { name: /play Test recording one/i }));
    // Sitting exactly on the third line's start: clicking it asks to go to 12
    // from 12, which is not backwards, so nothing happens.
    playTo(media, 12);
    fireEvent.click(lines()[2]);
    expect(media.currentTime).toBe(12);

    // A moment later, replaying the line from its start is allowed.
    playTo(media, 14);
    fireEvent.click(lines()[2]);
    expect(media.currentTime).toBe(12);
  });

  it('says plainly that there is no transcript, and shows no empty box', async () => {
    renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript({ text: null, segments: [] })] });

    expect(await screen.findByText(/no written transcript of this call yet/i)).toBeTruthy();
    expect(document.querySelector('[data-transcript]')?.dataset.transcript).toBe('none');
    expect(lines()).toHaveLength(0);
    expect(screen.queryByText(/what was said on this call/i)).toBeNull();
  });

  it('says so differently when transcribing was tried and failed', async () => {
    renderPlayer({
      [`GET ${TRANSCRIPT_PATH}`]: [200, transcript({ status: 'FAILED', text: null, segments: [] })],
    });
    expect(await screen.findByText(/could not be transcribed/i)).toBeTruthy();
  });

  it('shows a transcript with no timings as text, and says it cannot follow along', async () => {
    renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript({ segments: [] })] });

    expect(await screen.findByText(/what was said on this call/i)).toBeTruthy();
    expect(screen.getByText(/cannot follow the audio/i)).toBeTruthy();
    expect(screen.getByText('Yes, speaking.')).toBeTruthy();
    // No clickable lines: there are no timings to click to.
    expect(lines()).toHaveLength(0);
  });

  it('names the speaker where the speaker changes, and nowhere else', async () => {
    // 'A' and 'B' are the recording's two channels, which hold one person each.
    // The last line is deliberately unattributed: on a real call that is the
    // handover, where both people are talking and neither channel is louder.
    const spoken = [
      { start: 0, end: 5, text: 'Good morning, this is Dana from the claims team.', speaker: 'A' },
      { start: 6, end: 10, text: 'Yes, speaking.', speaker: 'B' },
      { start: 12, end: 16, text: 'That is right, I sent it on Tuesday.', speaker: 'B' },
      { start: 17, end: 20, text: 'Sorry, go on.' },
    ];
    renderPlayer({
      [`GET ${TRANSCRIPT_PATH}`]: [
        200,
        transcript({ segments: spoken, text: spoken.map((s) => s.text).join('\n') }),
      ],
    });
    await screen.findByText(/what was said on this call/i);

    const badges = [...document.querySelectorAll('[data-speaker]')];
    // Three names on four lines: line 3 continues line 2, so it is not named
    // again. A name against every line of a long answer would be noise.
    expect(badges.map((b) => b.textContent)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker unclear']);
    expect(badges.map((b) => b.dataset.speaker)).toEqual(['A', 'B', 'unknown']);

    // The line nobody could attribute says so, rather than being folded into the
    // speaker above it.
    expect(lines()[3].textContent).toContain('Speaker unclear');
    expect(lines()[2].textContent).not.toContain('Speaker');

    // And the panel says once, at the top, what the two names actually mean: a
    // trainee must not read "Speaker 1" as somebody's view of who the adviser is.
    expect(screen.getByText(/two sides of the call/i)).toBeTruthy();
    expect(screen.getByText(/which one is the adviser is not something/i)).toBeTruthy();
  });

  it('shows no speaker names at all when the transcript has none', async () => {
    // A transcript made before the labels existed, one typed in by a person, or one
    // of a recording that turned out not to be dual-channel. A column of "unclear"
    // down every line would look like a fault; there is simply nothing to say.
    renderPlayer({ [`GET ${TRANSCRIPT_PATH}`]: [200, transcript()] });
    await screen.findByText(/what was said on this call/i);

    expect(document.querySelectorAll('[data-speaker]')).toHaveLength(0);
    expect(screen.queryByText(/two sides of the call/i)).toBeNull();
    expect(lines()).toHaveLength(3);
  });

  it('renders nothing at all when the transcript cannot be fetched', async () => {
    // mockFetch answers an unknown route with 404, which is what a server without
    // this endpoint would do. A transcript must never break the player.
    const media = renderPlayer();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-transcript]')).toBeNull();
    });
    // And the recording still plays.
    fireEvent.click(screen.getByRole('button', { name: /play Test recording one/i }));
    playTo(media, 4);
    expect(media.currentTime).toBe(4);
  });
});
