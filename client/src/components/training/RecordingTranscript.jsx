import { memo, useEffect, useMemo, useRef } from 'react';
import { useRecordingTranscript } from '../../api/media.js';

/*
 * The transcript panel under a recording: what was said, line by line, with the
 * line being spoken highlighted as the audio plays.
 *
 * THE ONE RULE THAT MATTERS MORE THAN ANY OTHER HERE
 *
 * Clicking a line goes BACKWARDS ONLY. The player forbids skipping forward —
 * that is the whole promise of the no-seek player, and the full listen is what
 * unlocks the stage quiz — so the transcript must not become the way round it.
 * Somebody who could read "the client agrees at 7:40" and click straight there
 * would have skipped the call and be one press from the quiz.
 *
 * Three separate things stop that, and none of them is enough on its own:
 *
 *   1. a line at or after the play head is rendered as a DISABLED button, so
 *      there is nothing to press. That is the honest UI: you cannot go there;
 *   2. `onSeekBack` in NoSeekPlayer refuses any position that is not strictly
 *      behind the play head, whatever this component asks for;
 *   3. the player's own `seeking` handler snaps any forward jump back to the
 *      furthest point honestly played, whoever caused it.
 *
 * If you change this file, leave all three alone.
 *
 * Everything shown here comes from the server. This component does not know
 * whether a transcript exists, and does not guess: no transcript is said plainly
 * (no empty box), and a transcript with no timings — which is what a transcript
 * typed in by a person looks like — is shown as text with a line saying it cannot
 * be followed along, rather than having times invented for it so that something
 * can be highlighted.
 */

/**
 * The two sides of the call, as the panel names them.
 *
 * 'A' and 'B' are the LEFT and RIGHT channels of the recording, and that is all
 * anybody knows: these calls are recorded with one person per channel, so which
 * side is talking is worked out from which channel is louder, with no model
 * involved (ops/media/transcribe.py). Which side the AGENT sits on is a property
 * of the phone system and is not the same on every recording we hold, so the panel
 * says "Speaker 1" and "Speaker 2" rather than "Agent" and "Client". Guessing that
 * the one who talks more is the agent would put a confident wrong name on the
 * compliance script, which is worse than a neutral one.
 *
 * A line with no speaker is a line nobody could attribute — the two channels were
 * comparable (both talking at once), or the line straddles the handover. It says
 * so, rather than being quietly folded into whoever spoke last.
 */
const SPEAKER_NAMES = { A: 'Speaker 1', B: 'Speaker 2' };

export function speakerName(speaker) {
  return SPEAKER_NAMES[speaker] ?? 'Speaker unclear';
}

const SPEAKER_TONES = {
  A: 'text-navy-mid',
  B: 'text-amber',
};

/** m:ss, the same shape the player's own clock uses. */
function fmt(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The index of the line being spoken at `position`: the last line that has
 * started. -1 before the first line starts.
 *
 * Deliberately NOT "the line whose start and end straddle the position". Whisper
 * leaves gaps between segments wherever nobody is speaking, and a rule that
 * needed `position < end` would drop the highlight into nothing during every
 * pause, making it flicker on and off through a call full of them. Once a line
 * has started it stays lit until the next one begins, which is what somebody
 * reading along expects.
 */
export function activeIndexAt(segments, position) {
  if (!Number.isFinite(position)) return -1;
  let index = -1;
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].start <= position) index = i;
    else break;
  }
  return index;
}

/**
 * The lines.
 *
 * Memoised on (segments, activeIndex, onSeek) so that the player's four
 * `timeupdate` events a second only re-render this list when the highlight
 * actually moves, rather than redrawing a hundred buttons four times a second.
 * That is why "can I click this line?" is expressed as `index <= activeIndex`
 * rather than as a fresh comparison against the live position: the same fact,
 * and it changes only when the highlight does. The exact instant where the play
 * head sits precisely on a line's start is caught by the player's guard, which
 * refuses a seek that is not strictly backwards.
 */
const TranscriptLines = memo(function TranscriptLines({
  segments,
  activeIndex,
  onSeek,
  listRef,
  hasSpeakers,
}) {
  // Keep the highlighted line in view INSIDE the panel, by setting the panel's
  // own scrollTop. Never scrollIntoView(): that is allowed to scroll the page as
  // well, and a page that scrolls itself while somebody is reading is exactly
  // what the Section 05 no-scroll rule exists to prevent.
  useEffect(() => {
    const list = listRef.current;
    if (list === null || activeIndex < 0) return;
    const line = list.children[activeIndex];
    if (line === undefined) return;
    const top = line.offsetTop - list.offsetTop;
    const bottom = top + line.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 8);
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 8;
    }
  }, [activeIndex, listRef]);

  return (
    <ol
      ref={listRef}
      aria-label="Transcript"
      className="max-h-[240px] overflow-y-auto overscroll-contain pr-1"
    >
      {segments.map((segment, index) => {
        const active = index === activeIndex;
        const heard = index <= activeIndex;
        // A speaker's name is shown only where the speaker CHANGES, which is how
        // a transcript is read: a name against every line of a forty-second answer
        // is noise. "Changes" includes changing to or from unattributed, so a line
        // nobody could pin down says so instead of joining the run above it.
        const showSpeaker =
          hasSpeakers &&
          (index === 0 || (segment.speaker ?? null) !== (segments[index - 1].speaker ?? null));
        return (
          <li key={`${String(segment.start)}-${String(index)}`}>
            <button
              type="button"
              disabled={!heard}
              aria-current={active ? 'true' : undefined}
              data-line={index}
              data-active={active ? 'true' : 'false'}
              onClick={() => {
                onSeek(segment.start);
              }}
              title={
                heard
                  ? `Play this line again from ${fmt(segment.start)}`
                  : 'You can go back to a line you have heard, but not forward to one you have not'
              }
              className={`flex w-full gap-2.5 rounded-[7px] px-2 py-1 text-left text-[13.5px] leading-[1.55] transition-colors ${
                active ? 'bg-orange-soft font-semibold text-navy' : 'text-ink'
              } ${
                // The hover tint is for the lines you may click BACK to. It is
                // left off the highlighted line, which would otherwise lose its
                // own colour under the pointer — the one line that must always
                // be findable.
                heard && !active ? 'cursor-pointer hover:bg-[#EEF1F5]' : ''
              } ${heard ? 'cursor-pointer' : 'cursor-default opacity-[0.55]'} focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange`}
            >
              <span className="w-[38px] shrink-0 pt-px text-[11px] text-muted tabular-nums">
                {fmt(segment.start)}
              </span>
              <span className="min-w-0 break-words">
                {showSpeaker ? (
                  <span
                    data-speaker={segment.speaker ?? 'unknown'}
                    className={`mr-1.5 text-[11px] font-bold tracking-[0.03em] uppercase ${
                      SPEAKER_TONES[segment.speaker] ?? 'text-muted'
                    }`}
                  >
                    {speakerName(segment.speaker)}
                  </span>
                ) : null}
                {segment.text}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
});

export default function RecordingTranscript({ recordingId, mediaType, position, onSeekBack }) {
  // A failure resolves to null, never throws: nothing about a transcript may get
  // in the way of playing the recording.
  const { data } = useRecordingTranscript(recordingId);
  const listRef = useRef(null);

  // `data.segments` is the array react-query is holding, so it is the same object
  // on every render and the memo below really does memoise. The empty fallback
  // gets its own memo so that "no data yet" does not hand useMemo a fresh array
  // four times a second.
  const segments = useMemo(() => data?.segments ?? [], [data]);
  const activeIndex = useMemo(() => activeIndexAt(segments, position), [segments, position]);
  // Whether this transcript knows who was speaking at all. A transcript made
  // before the labels existed, one typed in by a person, and one of a recording
  // that turned out not to be dual-channel all have no speaker on any line — and
  // in that case the panel shows no names at all rather than a column of
  // "unclear", which would look like something had gone wrong.
  const hasSpeakers = useMemo(
    () => segments.some((segment) => segment.speaker !== undefined),
    [segments],
  );

  // Still asking, or could not ask: nothing on the page at all.
  if (!data) return null;

  const isVideo = mediaType === 'VIDEO';
  const noun = isVideo ? 'recording' : 'call';

  if (data.text === null) {
    return (
      <div className="mt-3 border-t border-line pt-3" data-transcript="none">
        <p className="text-[12.5px] text-muted">
          {data.status === 'FAILED'
            ? `This ${noun} could not be transcribed, so there is no text to read along with. Tell your manager if you were expecting one.`
            : `There is no written transcript of this ${noun} yet, so there is nothing to read along with while you listen.`}
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-3 border-t border-line pt-3"
      data-transcript={segments.length === 0 ? 'text-only' : 'timed'}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-[11px] font-bold tracking-[0.05em] text-muted uppercase">
          What was said on this {noun}
        </p>
        <span className="text-[11.5px] text-muted">
          {segments.length === 0
            ? 'No timings for this one, so it cannot follow the audio.'
            : 'Follows the audio. Click a line you have heard to play it again — there is no jumping ahead.'}
        </span>
        {hasSpeakers ? (
          // Said once, at the top, rather than implied by the names down the side:
          // a trainee should know that "Speaker 1" is the recording's two channels
          // and not somebody's judgement about who is the adviser.
          <span className="text-[11.5px] text-muted">
            Speaker 1 and Speaker 2 are the two sides of the call, told apart by the
            recording&apos;s two channels. Which one is the adviser is not something the recording
            says.
          </span>
        ) : null}
      </div>

      <div className="rounded-[10px] border border-line bg-bg px-2 py-2">
        {segments.length === 0 ? (
          // Words but no timings: a transcript somebody typed in. It is shown as
          // it is, because inventing times so that something could be highlighted
          // would be making the one thing on this screen up.
          <div className="max-h-[240px] space-y-1.5 overflow-y-auto overscroll-contain px-2 py-1 text-[13.5px] leading-[1.55] text-ink">
            {data.text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
              .map((line, index) => (
                <p key={index} className="break-words">
                  {line}
                </p>
              ))}
          </div>
        ) : (
          <TranscriptLines
            segments={segments}
            activeIndex={activeIndex}
            onSeek={onSeekBack}
            listRef={listRef}
            hasSpeakers={hasSpeakers}
          />
        )}
      </div>
    </div>
  );
}
