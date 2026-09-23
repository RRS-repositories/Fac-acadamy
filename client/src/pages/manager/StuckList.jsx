import { Link } from 'react-router-dom';
import ManagerLayout from '../../components/manager/ManagerLayout.jsx';
import StuckReason from '../../components/manager/StuckReason.jsx';
import { ErrorNotice, Notice } from '../../components/manager/Notice.jsx';
import { useStuck } from '../../api/manager.js';
import { cardClass } from '../../components/training/styles.js';
import { relativeTime, trackLabel } from '../../lib/format.js';

/*
 * Needs attention (Section 07 task 1, the v_stuck_trainees panel) on its own
 * page, linked from a banner on the roster. It is a short list a manager acts
 * on, so it gets room to say why each person is on it rather than a cell in an
 * already wide table.
 *
 * The server decides who is stuck — 3 or more fails on one stage, or 7 days
 * without activity. This page only explains the decision.
 */

export default function StuckList() {
  const stuck = useStuck();
  const rows = stuck.data?.trainees ?? [];

  return (
    <ManagerLayout title="Needs attention">
      <p className="mb-5 max-w-[640px] text-[13.5px] text-muted">
        Anyone who has failed the same stage three times or more, or who has not touched their
        training for a week. Have a word, or reassign their track from the roster.
      </p>

      {stuck.isError ? (
        <ErrorNotice error={stuck.error} what="the list" onRetry={() => stuck.refetch()} />
      ) : stuck.isPending ? (
        <Notice title="Loading…" />
      ) : rows.length === 0 ? (
        <Notice title="Nobody is stuck.">
          Every trainee is either moving through their programme or has finished it.
        </Notice>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              data-stuck={row.id}
              data-reason={row.reason}
              className={`${cardClass} flex flex-wrap items-center justify-between gap-3 px-5 py-4`}
            >
              <span className="min-w-0">
                <Link
                  to={`/manager/trainee/${row.id}`}
                  className="font-display text-[15px] font-bold text-navy underline"
                >
                  {row.fullName}
                </Link>
                <span className="mt-0.5 block text-[12.5px] text-muted">
                  {trackLabel(row.track)} · last active {relativeTime(row.lastActivityAt)}
                </span>
              </span>
              <StuckReason row={row} />
            </li>
          ))}
        </ul>
      )}
    </ManagerLayout>
  );
}
