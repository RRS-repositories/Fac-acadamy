import { useTrack } from '../../api/training.js';
import { useMyCertificates } from '../../api/certs.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import WaitingForTrack from '../WaitingForTrack.jsx';
import AccomplishmentBanner from '../../components/training/AccomplishmentBanner.jsx';
import DeptSection from '../../components/training/DeptSection.jsx';
import LevelSection from '../../components/training/LevelSection.jsx';
import NextUpCta from '../../components/training/NextUpCta.jsx';
import ProgressRing from '../../components/training/ProgressRing.jsx';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import { btnGhost, cardClass, heroGradient } from '../../components/training/styles.js';

/*
 * The trainee's dashboard — the prototype's dashboard screen on /api/track.
 *
 * Everything on it comes from the server: the stages, their order, their
 * state, the best score and the attempt count. The client decides nothing
 * about what is unlocked; it only draws what the gate already decided.
 */

function firstName(fullName) {
  const name = String(fullName ?? '').trim();
  return name.split(/\s+/)[0] || 'there';
}

/** Group the level stages by level, keeping the track's own order. */
function byLevel(stages) {
  const groups = [];
  for (const stage of stages) {
    const level = stage.level ?? 0;
    const group = groups.find((g) => g.level === level);
    if (group) group.stages.push(stage);
    else groups.push({ level, stages: [stage] });
  }
  return groups;
}

function Panel({ title, children }) {
  return (
    <section className={`${cardClass} p-6`}>
      <h1 className="text-lg font-semibold">{title}</h1>
      {children}
    </section>
  );
}

export default function Dashboard() {
  const { me } = useAuth();
  const track = useTrack();
  // S09: the accomplishment banner. A separate query, so a slow or failing
  // certificate call can never keep the training itself off the screen.
  const certificates = useMyCertificates();

  if (track.isPending) {
    return (
      <TrainingLayout>
        <Panel title="Loading your training…">
          <p className="mt-2 text-muted">One moment.</p>
        </Panel>
      </TrainingLayout>
    );
  }

  if (track.isError) {
    return (
      <TrainingLayout>
        <Panel title="We couldn't load your training.">
          <p className="mt-2 text-muted">Please try again in a moment.</p>
          <button type="button" className={`${btnGhost} mt-4`} onClick={() => track.refetch()}>
            Try again
          </button>
        </Panel>
      </TrainingLayout>
    );
  }

  // D13 — the manager has not assigned a programme yet. One screen owns that.
  if (track.data.waitingForTrack || track.data.stages.length === 0) {
    return <WaitingForTrack />;
  }

  const stages = track.data.stages;
  const levelStages = stages.filter((s) => s.dept === null);
  const deptStages = stages.filter((s) => s.dept !== null);
  const levels = byLevel(levelStages);
  const levelHeadings = new Map((track.data.levels ?? []).map((l) => [l.level, l]));
  const deptHeading = (track.data.depts ?? [])[0] ?? null;

  // The one stage the pulse belongs to: the first one still open in track
  // order. Passed stages are 'done', so this is never a stage already behind
  // the trainee.
  const next = stages.find((s) => s.state === 'available') ?? null;
  const passed = stages.filter((s) => s.state === 'done').length;
  const overall = Math.round((passed / stages.length) * 100);
  const allDone = passed === stages.length;
  const name = firstName(me?.fullName);

  return (
    <TrainingLayout>
      <AccomplishmentBanner certificates={certificates.data?.certificates ?? []} />
      <section
        style={heroGradient}
        className="relative mb-6 flex flex-col gap-7 overflow-hidden rounded-card px-6 py-8 text-white md:flex-row md:items-center md:justify-between lg:px-[38px] lg:py-[34px]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-[70px] -bottom-[110px] h-[280px] w-[280px] rounded-full border-[36px] border-orange/20"
        />
        <div className="relative z-10">
          <h1 className="mb-2 text-[27px] font-bold text-white">
            {allDone ? `Training complete, ${name}! 🎉` : `Welcome back, ${name}`}
          </h1>
          <p className="max-w-[520px] text-[14.5px] text-white/75">
            {allDone
              ? "You've passed every stage in your programme. Your manager has been told you're ready."
              : 'Work through each stage in order — lessons, then the call recordings, then pass the quiz to unlock the next stage.'}
          </p>
          {next ? (
            <NextUpCta to={`/stage/${encodeURIComponent(next.code)}`} className="mt-5">
              {next.attempts > 0 ? 'Continue' : 'Start'} {next.dept === null ? 'Stage' : 'Module'}{' '}
              {next.displayNum}: {next.title} →
            </NextUpCta>
          ) : null}
        </div>
        <div className="relative z-10 flex items-center gap-3.5">
          <ProgressRing value={overall} />
        </div>
      </section>

      {levels.map((group, i) => (
        <LevelSection
          key={group.level}
          level={group.level}
          heading={levelHeadings.get(group.level) ?? null}
          stages={group.stages}
          nextCode={next?.code ?? null}
          first={i === 0}
        />
      ))}

      {deptStages.length > 0 ? (
        <DeptSection stages={deptStages} nextCode={next?.code ?? null} heading={deptHeading} />
      ) : null}
    </TrainingLayout>
  );
}
