import type { StageState } from '@fac-academy/shared';
import {
  loadCompletedStageIds,
  loadStage1Authorised,
  loadStagesForTrack,
  loadTrack,
  stageExists,
} from './repo.js';
import type { Db, StageRow, VisibleStages } from './repo.js';

// THE gate. Every content route goes through gate() — no route re-implements
// an unlock rule, and no route trusts anything the client sent.
//
// The rule (build spec S04, PROJECT-PLAN §1):
//   * a trainee's track gives an ordered list of stages (academy.track_visibility,
//     position order). A stage outside that list does not exist for them;
//   * position 0 (the first stage in their list) is always available;
//   * every later stage needs the PREVIOUS visible stage passed, i.e. a row in
//     academy.stage_completions;
//   * a stage already passed stays open (unlimited retakes, re-reading);
//   * when config STAGE1_AUTH_REQUIRED is on, every stage after the first also
//     needs academy.progression_authorisations.authorised = TRUE. It is a
//     config flag with no UI: off by default.

export type GateDenial = 'no_track' | 'not_visible' | 'locked' | 'not_found';

export type GateResult =
  { allowed: true; stage: StageRow } | { allowed: false; reason: GateDenial; requires?: string };

export interface GateOptions {
  /** Config STAGE1_AUTH_REQUIRED. Default false. */
  stage1AuthRequired?: boolean;
  /** Already loaded by the caller (GET /api/track), to save a query. */
  visible?: VisibleStages;
}

export interface Progression {
  /** Ids of the stages this trainee has passed. */
  completed: ReadonlySet<number>;
  stage1Authorised: boolean;
}

/**
 * The stages this trainee's track sees, in unlock order. One source of truth
 * for gate(), GET /api/track and the quiz routes.
 */
export async function visibleStages(db: Db, traineeId: number): Promise<VisibleStages> {
  const track = await loadTrack(db, traineeId);
  if (track === null) return { track: null, stages: [] };
  return { track, stages: await loadStagesForTrack(db, track) };
}

/** Completions (and the manager authorisation, when the flag needs it). */
export async function loadProgression(
  db: Db,
  traineeId: number,
  stages: StageRow[],
  stage1AuthRequired: boolean,
): Promise<Progression> {
  const completed = await loadCompletedStageIds(
    db,
    traineeId,
    stages.map((s) => s.id),
  );
  const stage1Authorised = stage1AuthRequired ? await loadStage1Authorised(db, traineeId) : true;
  return { completed, stage1Authorised };
}

/**
 * The state of every visible stage, in the same order. Pure: the single place
 * the unlock rule is written down. gate() reads one entry of this array.
 */
export function stageStates(
  stages: readonly StageRow[],
  progression: Progression,
  stage1AuthRequired: boolean,
): StageState[] {
  return stages.map((stage, i) => {
    if (progression.completed.has(stage.id)) return 'done';
    if (i === 0) return 'available';
    const previous = stages[i - 1];
    if (previous === undefined || !progression.completed.has(previous.id)) return 'locked';
    if (stage1AuthRequired && !progression.stage1Authorised) return 'locked';
    return 'available';
  });
}

/**
 * What a locked stage is waiting for: the previous visible stage's code. When
 * the manager authorisation is the only thing missing, it is the first stage's
 * code (the one whose pass is being authorised).
 */
function requirementFor(
  stages: readonly StageRow[],
  index: number,
  progression: Progression,
): string | undefined {
  const previous = stages[index - 1];
  if (previous !== undefined && !progression.completed.has(previous.id)) return previous.code;
  return stages[0]?.code;
}

export async function gate(
  db: Db,
  traineeId: number,
  stageCode: string,
  opts: GateOptions = {},
): Promise<GateResult> {
  const stage1AuthRequired = opts.stage1AuthRequired ?? false;
  const visible = opts.visible ?? (await visibleStages(db, traineeId));

  if (visible.track === null) return { allowed: false, reason: 'no_track' };

  const index = visible.stages.findIndex((s) => s.code === stageCode);
  if (index === -1) {
    // Never say whether the stage exists on some other track.
    return {
      allowed: false,
      reason: (await stageExists(db, stageCode)) ? 'not_visible' : 'not_found',
    };
  }
  const stage = visible.stages[index]!;

  const progression = await loadProgression(db, traineeId, visible.stages, stage1AuthRequired);
  const state = stageStates(visible.stages, progression, stage1AuthRequired)[index];
  if (state === 'locked') {
    const requires = requirementFor(visible.stages, index, progression);
    return requires === undefined
      ? { allowed: false, reason: 'locked' }
      : { allowed: false, reason: 'locked', requires };
  }
  return { allowed: true, stage };
}
