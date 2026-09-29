import { useRecordingSummary, useSummariseRecording } from '../../api/media.js';
import { btnGhost, btnSmall } from './styles.js';

/*
 * The "Summarise" button under a recording, and the summary it shows.
 *
 * What it is: a short factual summary of WHAT WAS SAID on the call, made once
 * from the recording's transcript and then stored. The first person to press the
 * button waits for the model; everybody after them is handed the stored text
 * straight away. It is a convenience before or after listening — never a
 * replacement for it, and the quiz still needs the full listen.
 *
 * Every state below comes from the server. This component does not know whether
 * the feature is switched on, whether a transcript exists, or whether somebody
 * else is having the same recording summarised at this moment; it renders the
 * `state` it is given. In particular:
 *
 *   disabled       render NOTHING. No button, no heading, no empty space. That
 *                  is what the feature being off has to look like.
 *   no_transcript  say so plainly, and do not offer a button that would do
 *                  nothing. There are no transcripts yet — transcription is
 *                  separate, later work — so today this is the honest state of
 *                  every recording, and pretending otherwise would be the one
 *                  unforgivable thing for this screen to do.
 *   ready          offer the button.
 *   working        somebody else's press is with the model. Ours did not start a
 *                  second one; say so and let them try again in a moment.
 *   done           show the summary.
 */

/**
 * The summary as paragraphs and bullet lines, from the model's plain text.
 *
 * The index is the key, which is safe here and only here: the lines come from
 * one immutable string that is written once and never edited, so the list never
 * reorders and no row has an identity of its own to preserve.
 */
function SummaryText({ text }) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  return (
    <div className="space-y-1.5 text-[13.5px] leading-[1.55] text-ink">
      {lines.map((line, index) =>
        line.startsWith('- ') || line.startsWith('• ') ? (
          <p key={index} className="flex gap-2">
            <span aria-hidden="true" className="text-orange">
              •
            </span>
            <span className="min-w-0 break-words">{line.slice(2)}</span>
          </p>
        ) : (
          <p key={index} className="break-words">
            {line}
          </p>
        ),
      )}
    </div>
  );
}

export default function RecordingSummary({ recordingId, mediaType }) {
  // A failure resolves to null, never throws: nothing about a summary may get in
  // the way of playing the recording.
  const { data } = useRecordingSummary(recordingId);
  const summarise = useSummariseRecording(recordingId);

  // Still asking, could not ask, or switched off: nothing on the page at all.
  if (!data || data.state === 'disabled') return null;

  const isVideo = mediaType === 'VIDEO';
  const noun = isVideo ? 'recording' : 'call';
  const working = summarise.isPending;
  const failed = summarise.isError;

  return (
    <div className="mt-3 border-t border-line pt-3" data-summary={data.state}>
      <div className="flex flex-wrap items-center gap-3">
        {data.state === 'no_transcript' ? (
          <p className="text-[12.5px] text-muted">
            A written summary of this {noun} isn&apos;t available yet — it hasn&apos;t been
            transcribed. Listen to it in full; there is nothing to read instead.
          </p>
        ) : null}

        {data.state === 'ready' || data.state === 'working' ? (
          <button
            type="button"
            onClick={() => {
              summarise.mutate();
            }}
            disabled={working}
            aria-busy={working ? 'true' : 'false'}
            className={`${btnGhost} ${btnSmall}`}
            data-testid={`summarise-${recordingId}`}
          >
            {working ? 'Summarising…' : `Summarise this ${noun}`}
          </button>
        ) : null}

        {data.state === 'ready' && !working && !failed ? (
          <span className="text-[12px] text-muted">
            Made once from the transcript, then shared with everyone.
          </span>
        ) : null}
      </div>

      {data.state === 'working' && !working ? (
        <p className="mt-2 text-[12.5px] text-muted">
          Somebody else is having this {noun} summarised right now — it is written once and then
          shared, so give it a moment and press again.
        </p>
      ) : null}

      {failed ? (
        <p className="mt-2 text-[12.5px] font-semibold text-amber">
          The summary couldn&apos;t be made just now, and nothing was saved. Press the button to try
          again, and tell your manager if it keeps happening.
        </p>
      ) : null}

      {data.state === 'done' && data.summary !== null ? (
        <div className="mt-1 rounded-[10px] border border-line bg-bg px-4 py-3">
          <p className="mb-1.5 text-[11px] font-bold tracking-[0.05em] text-muted uppercase">
            What was said on this {noun}
          </p>
          <SummaryText text={data.summary} />
          <p className="mt-2.5 text-[11.5px] text-muted">
            Written by AI from the transcript, so read it as a guide and not as the record. The
            recording itself is what counts.
          </p>
        </div>
      ) : null}

      <p role="status" className="sr-only">
        {working ? `Summarising this ${noun}` : ''}
      </p>
    </div>
  );
}
