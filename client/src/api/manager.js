import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANAGER_ERROR_CODES,
  ManagerConfigSchema,
  PreviewTrackResponseSchema,
  RosterResponseSchema,
  StuckResponseSchema,
  TraineeDetailSchema,
} from '@fac-academy/shared';
import { ApiError } from './client.js';

/*
 * The management data layer (S07) — the only place the browser talks to the
 * manager API. Every manager screen imports from here, so there is one query
 * key per resource and one cache to invalidate after an action.
 *
 * Nothing here holds a lesson, a question or an answer. The manager screens
 * show progress numbers and account state only; the preview screen lists stage
 * titles and never asks for lesson content.
 *
 * Why it does not reuse request() from client.js: that helper reads failures
 * with the *auth* error contract. The manager API has its own small one
 * ({ error: 'forbidden' | 'not_found' | 'invalid_request' | 'rate_limited' }),
 * and the screens branch on those codes.
 */

/** One object so a screen never invents a key and misses an invalidation. */
export const managerKeys = {
  all: ['manager'],
  roster: () => ['manager', 'roster'],
  stuck: () => ['manager', 'stuck'],
  trainee: (id) => ['manager', 'trainee', String(id)],
  preview: (track) => ['manager', 'preview', track],
  config: () => ['manager', 'config'],
};

/** The roster refresh beat. The dashboard is a live view of who is working. */
export const ROSTER_REFRESH_MS = 30_000;

/** Server-generated, audited CSV. A plain authenticated GET, so a link is enough. */
export const EXPORT_CSV_PATH = '/api/manager/export.csv';

/**
 * What went wrong, said plainly, for the account controls on the roster.
 *
 * "That didn't save" told a manager nothing: the commonest failure by far is
 * trying to disable your own account, which the server refuses on purpose, and
 * a generic line made that look like a bug. Each code now has its own sentence
 * and, where the manager can act on it, says what to do next.
 */
export const ACTION_ERROR_MESSAGES = {
  invalid_request: "You can't disable your own account.",
  forbidden: 'Only a manager can do that.',
  not_found: 'That trainee no longer exists. Refresh the page.',
  rate_limited: 'Too many changes at once. Wait a moment.',
  not_signed_in: 'Your session ended. Sign in again.',
  network: "Couldn't reach the server.",
  flag_off: "The training portal isn't open yet.",
};

/** The sentence for one failed action; a last-resort line for anything else. */
export function actionErrorMessage(error) {
  return ACTION_ERROR_MESSAGES[error?.code] ?? 'That change did not save. Please try again.';
}

const MANAGER_ERRORS = new Set(MANAGER_ERROR_CODES);

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function failureFrom(status, body) {
  if (status === 503 && body && body.flag === 'off') return new ApiError(status, 'flag_off');
  if (body && MANAGER_ERRORS.has(body.error)) return new ApiError(status, body.error);
  if (status === 401) return new ApiError(status, 'not_signed_in');
  if (status === 403) return new ApiError(status, 'forbidden');
  if (status === 404) return new ApiError(status, 'not_found');
  return new ApiError(status, 'unknown');
}

async function managerRequest(method, path, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', `Request to ${path} could not reach the server`);
  }
  if (!res.ok) throw failureFrom(res.status, await readJson(res));
  if (res.status === 204) return null;
  return readJson(res);
}

/**
 * Validate with the shared zod schema; a mismatch is a failure, not a render.
 * It also strips anything the contract does not name, so a field the API
 * should never send cannot reach a screen by accident.
 */
function parseWith(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

// --- Plain calls -----------------------------------------------------------

/**
 * GET /api/manager/roster. Asked for once, disabled accounts included: the
 * search box, the track filter and the "show disabled" switch all narrow the
 * list in the browser. One URL means one cache entry, so typing never fires a
 * request, the 30-second refresh never moves the page under the manager's
 * cursor, and an optimistic disable has exactly one place to write.
 */
export async function fetchRoster() {
  return parseWith(
    RosterResponseSchema,
    await managerRequest('GET', '/api/manager/roster?includeDisabled=true'),
  );
}

export async function fetchStuck() {
  return parseWith(StuckResponseSchema, await managerRequest('GET', '/api/manager/stuck'));
}

export async function fetchTrainee(id) {
  return parseWith(
    TraineeDetailSchema,
    await managerRequest('GET', `/api/manager/trainee/${encodeURIComponent(id)}`),
  );
}

export async function fetchPreview(track) {
  return parseWith(
    PreviewTrackResponseSchema,
    await managerRequest('GET', `/api/manager/preview/${encodeURIComponent(track)}`),
  );
}

export async function fetchManagerConfig() {
  return parseWith(ManagerConfigSchema, await managerRequest('GET', '/api/manager/config'));
}

export async function setTraineeDisabled(id, disabled) {
  const action = disabled ? 'disable' : 'enable';
  await managerRequest('POST', `/api/manager/trainees/${encodeURIComponent(id)}/${action}`);
  return null;
}

export async function assignTrack(id, track) {
  await managerRequest('PUT', `/api/manager/trainees/${encodeURIComponent(id)}/track`, { track });
  return null;
}

// --- Hooks ------------------------------------------------------------------

// Manager failures are deterministic (forbidden, not found, bad request), so a
// retry only delays the message that explains them.
const NO_RETRY = { retry: false, refetchOnWindowFocus: false };

/** The live roster: every trainee, refreshed on the beat. */
export function useRoster() {
  return useQuery({
    queryKey: managerKeys.roster(),
    queryFn: fetchRoster,
    refetchInterval: ROSTER_REFRESH_MS,
    // Keep the rows on screen while a refresh is in flight: no blank table,
    // no jump back to the top of the page.
    placeholderData: keepPreviousData,
    ...NO_RETRY,
  });
}

/** Trainees with 3+ fails on a stage or a week of silence. */
export function useStuck() {
  return useQuery({
    queryKey: managerKeys.stuck(),
    queryFn: fetchStuck,
    refetchInterval: ROSTER_REFRESH_MS,
    placeholderData: keepPreviousData,
    ...NO_RETRY,
  });
}

/** One trainee and their per-stage record. */
export function useTrainee(id) {
  return useQuery({
    queryKey: managerKeys.trainee(id),
    queryFn: () => fetchTrainee(id),
    enabled: Boolean(id),
    refetchInterval: ROSTER_REFRESH_MS,
    placeholderData: keepPreviousData,
    ...NO_RETRY,
  });
}

/** The stage list a track sees. Read-only, and never lesson content. */
export function usePreview(track) {
  return useQuery({
    queryKey: managerKeys.preview(track),
    queryFn: () => fetchPreview(track),
    enabled: Boolean(track),
    ...NO_RETRY,
  });
}

/** STAGE1_AUTH_REQUIRED / ACADEMY_V2 / provisioning, read-only. */
export function useManagerConfig() {
  return useQuery({
    queryKey: managerKeys.config(),
    queryFn: fetchManagerConfig,
    staleTime: 5 * 60 * 1000,
    ...NO_RETRY,
  });
}

/** Write the new row state into every cached roster and trainee record. */
function patchTrainee(queryClient, id, patch) {
  queryClient.setQueryData(managerKeys.roster(), (previous) => {
    if (!previous?.trainees) return previous;
    return {
      ...previous,
      trainees: previous.trainees.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    };
  });
  queryClient.setQueryData(managerKeys.trainee(id), (previous) => {
    if (!previous?.trainee) return previous;
    return { ...previous, trainee: { ...previous.trainee, ...patch } };
  });
}

function snapshot(queryClient, id) {
  return {
    roster: queryClient.getQueryData(managerKeys.roster()),
    trainee: queryClient.getQueryData(managerKeys.trainee(id)),
  };
}

function restore(queryClient, id, previous) {
  if (previous?.roster !== undefined) {
    queryClient.setQueryData(managerKeys.roster(), previous.roster);
  }
  if (previous?.trainee !== undefined) {
    queryClient.setQueryData(managerKeys.trainee(id), previous.trainee);
  }
}

/**
 * Disable / re-enable an account (the S03 endpoints). The row changes at once
 * and the roster is refetched afterwards, so the screen ends up agreeing with
 * the server even if the write raced with the 30-second refresh.
 */
export function useSetDisabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, disabled }) => setTraineeDisabled(id, disabled),
    onMutate: async ({ id, disabled }) => {
      await queryClient.cancelQueries({ queryKey: managerKeys.all });
      const previous = snapshot(queryClient, id);
      // A disabled account's session dies within seconds, so the dot goes out
      // with it rather than waiting for the next refresh.
      patchTrainee(
        queryClient,
        id,
        disabled ? { isDisabled: true, onlineNow: false } : { isDisabled: false },
      );
      return previous;
    },
    onError: (_error, { id }, previous) => restore(queryClient, id, previous),
    onSettled: (_data, _error, { id }) => {
      queryClient.invalidateQueries({ queryKey: managerKeys.roster() });
      queryClient.invalidateQueries({ queryKey: managerKeys.trainee(id) });
      queryClient.invalidateQueries({ queryKey: managerKeys.stuck() });
    },
  });
}

/**
 * PUT the trainee's track (D13: first-time trainees start without one). The
 * server recomputes what that account can see; the client only shows the new
 * label.
 */
export function useAssignTrack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, track }) => assignTrack(id, track),
    onMutate: async ({ id, track }) => {
      await queryClient.cancelQueries({ queryKey: managerKeys.all });
      const previous = snapshot(queryClient, id);
      patchTrainee(queryClient, id, { track });
      return previous;
    },
    onError: (_error, { id }, previous) => restore(queryClient, id, previous),
    onSettled: (_data, _error, { id }) => {
      queryClient.invalidateQueries({ queryKey: managerKeys.roster() });
      queryClient.invalidateQueries({ queryKey: managerKeys.trainee(id) });
    },
  });
}
