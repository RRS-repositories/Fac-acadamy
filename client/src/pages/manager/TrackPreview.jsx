import { useId } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { TRACKS } from '@fac-academy/shared';
import ManagerLayout from '../../components/manager/ManagerLayout.jsx';
import { ErrorNotice, Notice } from '../../components/manager/Notice.jsx';
import { usePreview } from '../../api/manager.js';
import { badgeBase, cardClass } from '../../components/training/styles.js';
import { trackLabel } from '../../lib/format.js';

/*
 * "Preview as track" (Section 07): the stage list a given track sees, so a
 * manager can check what they are about to assign before they assign it.
 *
 * It is read-only and it is not a trainee session: nothing is unlocked,
 * nothing is recorded, and no lesson or quiz is ever requested — the screen
 * asks for /api/manager/preview/:track and renders stage titles alone.
 */

function sectionOf(stage) {
  if (stage.dept !== null && stage.dept !== undefined) return 'Department training';
  return `Level ${stage.level ?? 1}`;
}

function group(stages) {
  const groups = [];
  for (const stage of stages) {
    const name = sectionOf(stage);
    const found = groups.find((g) => g.name === name);
    if (found) found.stages.push(stage);
    else groups.push({ name, stages: [stage] });
  }
  return groups;
}

export default function TrackPreview() {
  const { track = '' } = useParams();
  const navigate = useNavigate();
  const pickerId = useId();
  const known = TRACKS.some((t) => t.code === track);
  const query = usePreview(known ? track : null);
  const stages = query.data?.stages ?? [];

  return (
    <ManagerLayout title="Preview a track">
      <section className={`${cardClass} px-6 py-5`}>
        <label htmlFor={pickerId} className="mb-1 block text-[12px] font-bold text-muted">
          Track
        </label>
        <select
          id={pickerId}
          value={known ? track : ''}
          onChange={(event) =>
            navigate(
              event.target.value === ''
                ? '/manager/preview'
                : `/manager/preview/${encodeURIComponent(event.target.value)}`,
            )
          }
          className="rounded-[10px] border-[1.5px] border-line bg-card px-3 py-2.5 text-sm font-semibold text-ink focus:border-orange"
        >
          <option value="">Choose a track…</option>
          {TRACKS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <span className={`${badgeBase} bg-orange-soft text-orange`}>Preview</span>
          You are looking at the programme, not at a trainee. Nothing on this page is recorded, and
          no lesson or quiz is opened.
        </p>
      </section>

      <div className="mt-5">
        {!known ? (
          <Notice title="Pick a track to preview.">
            {track === ''
              ? 'Choose one of the nine programmes above to see the stages it contains.'
              : `“${track}” is not one of the nine tracks.`}
          </Notice>
        ) : query.isError ? (
          <ErrorNotice error={query.error} what="that track" onRetry={() => query.refetch()} />
        ) : query.isPending ? (
          <Notice title="Loading the stage list…" />
        ) : stages.length === 0 ? (
          <Notice title={`${trackLabel(track)} has no stages yet.`}>
            Nothing is published for this programme, so a trainee on it would see an empty journey.
          </Notice>
        ) : (
          <section data-preview={query.data?.track ?? track} className={`${cardClass} px-6 py-6`}>
            <h2 className="font-display text-lg font-bold">
              {trackLabel(query.data?.track ?? track)} — {stages.length} stage
              {stages.length === 1 ? '' : 's'}
            </h2>
            {group(stages).map((section) => (
              <div key={section.name} className="mt-5">
                <h3 className="text-[11px] font-bold tracking-[0.12em] text-orange uppercase">
                  {section.name}
                </h3>
                <ol className="mt-2 grid gap-2">
                  {section.stages.map((stage) => (
                    <li
                      key={stage.code}
                      data-stage={stage.code}
                      className="flex items-center gap-3 rounded-[10px] border border-line px-4 py-2.5"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg font-display text-[12.5px] font-bold text-navy"
                      >
                        {stage.displayNum ?? '•'}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-semibold text-navy">
                          {stage.title}
                        </span>
                        {/* Counts only — never a lesson, a question or an answer. */}
                        <span className="block text-[12px] text-muted tabular-nums">
                          {stage.lessonCount} lesson{stage.lessonCount === 1 ? '' : 's'}
                          {stage.recordingCount > 0
                            ? ` · ${stage.recordingCount} recording${stage.recordingCount === 1 ? '' : 's'}`
                            : ''}
                          {' · '}
                          {stage.questionCount} question{stage.questionCount === 1 ? '' : 's'} ·
                          pass {stage.passMark}%
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </section>
        )}
      </div>
    </ManagerLayout>
  );
}
