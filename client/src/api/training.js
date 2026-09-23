import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LockedResponseSchema,
  QuizResponseSchema,
  QuizResultSchema,
  StageResponseSchema,
  TrackResponseSchema,
  TrainingErrorSchema,
} from '@fac-academy/shared';
import { ApiError } from './client.js';

/*
 * The training data layer — the only place the browser talks to the training
 * API. Every screen (dashboard, stage, lesson, quiz, status guide) imports
 * from here, so there is one query key per resource and one cache to
 * invalidate.
 *
 * Why it does not reuse request() from client.js: that helper reads failures
 * with the *auth* error contract. Training has its own (shared/contracts/
 * training.ts) and a locked stage answers 403 with `requires` as well as
 * `error`, which the caller needs. The fetch itself is a handful of lines, so
 * the training contract is read here instead of widening the auth one.
 *
 * Nothing here holds lesson text, a question or an answer: every string the
 * trainee reads arrives at runtime from the server.
 */

/** One object so a screen never invents a key and misses an invalidation. */
export const trainingKeys = {
  all: ['training'],
  track: () => ['training', 'track'],
  stage: (code) => ['training', 'stage', code],
  quiz: (code) => ['training', 'quiz', code],
};

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fallbackCode(status, body) {
  if (status === 503 && body && body.flag === 'off') return 'flag_off';
  if (status === 401) return 'not_signed_in';
  if (status === 404) return 'not_found';
  return 'unknown';
}

/**
 * Turn a failed training response into an ApiError.
 *   .code      'locked' | 'not_found' | 'lessons_incomplete' | 'no_track' | …
 *   .requires  the stage code that must be passed first (403 locked), else null
 */
function failureFrom(status, body) {
  const locked = LockedResponseSchema.safeParse(body);
  if (locked.success) {
    const error = new ApiError(status, 'locked', 'That stage is locked');
    error.requires = locked.data.requires;
    return error;
  }
  const known = TrainingErrorSchema.safeParse(body);
  const error = new ApiError(status, known.success ? known.data.error : fallbackCode(status, body));
  error.requires = null;
  return error;
}

async function trainingRequest(method, path, body) {
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

/** Validate with the shared zod schema; a mismatch is a failure, not a render. */
function parseWith(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const error = new ApiError(200, 'bad_response', 'Unexpected response from server');
    error.requires = null;
    throw error;
  }
  return parsed.data;
}

// --- Plain calls (used by the hooks, and by tests that want no cache) -------

export async function fetchTrack() {
  return parseWith(TrackResponseSchema, await trainingRequest('GET', '/api/track'));
}

export async function fetchStage(code) {
  return parseWith(
    StageResponseSchema,
    await trainingRequest('GET', `/api/stage/${encodeURIComponent(code)}`),
  );
}

export async function markLessonRead(lessonId) {
  await trainingRequest('POST', `/api/lesson/${encodeURIComponent(lessonId)}/read`);
  return null;
}

export async function fetchQuiz(code) {
  return parseWith(
    QuizResponseSchema,
    await trainingRequest('GET', `/api/stage/${encodeURIComponent(code)}/quiz`),
  );
}

export async function submitQuiz(code, answers) {
  return parseWith(
    QuizResultSchema,
    await trainingRequest('POST', `/api/stage/${encodeURIComponent(code)}/quiz`, { answers }),
  );
}

// --- Hooks ------------------------------------------------------------------

// Training failures are deterministic (locked, not found, no track), so a
// retry only delays the screen that explains them.
const NO_RETRY = { retry: false, refetchOnWindowFocus: false };

/** GET /api/track — the trainee's journey, in unlock order. */
export function useTrack() {
  return useQuery({ queryKey: trainingKeys.track(), queryFn: fetchTrack, ...NO_RETRY });
}

/**
 * GET /api/stage/:code. A locked stage rejects with ApiError
 * { code: 'locked', requires }, an unknown or other-track stage with
 * { code: 'not_found' }.
 */
export function useStage(code) {
  return useQuery({
    queryKey: trainingKeys.stage(code),
    queryFn: () => fetchStage(code),
    enabled: Boolean(code),
    ...NO_RETRY,
  });
}

/**
 * POST /api/lesson/:id/read. Call with { stageCode, lessonId }: the tick
 * appears at once (optimistic), and the stage and track queries are refreshed
 * afterwards so the pills, the rail and the dashboard agree with the server.
 */
export function useMarkLessonRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lessonId }) => markLessonRead(lessonId),
    onMutate: async ({ stageCode, lessonId }) => {
      if (!stageCode) return { stageCode: null, previous: undefined };
      const key = trainingKeys.stage(stageCode);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      if (previous) {
        queryClient.setQueryData(key, {
          ...previous,
          lessons: previous.lessons.map((lesson) =>
            lesson.id === lessonId ? { ...lesson, read: true } : lesson,
          ),
        });
      }
      return { stageCode, previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(trainingKeys.stage(context.stageCode), context.previous);
      }
    },
    onSettled: (_data, _error, variables) => {
      if (variables?.stageCode) {
        queryClient.invalidateQueries({ queryKey: trainingKeys.stage(variables.stageCode) });
      }
      queryClient.invalidateQueries({ queryKey: trainingKeys.track() });
    },
  });
}

/**
 * GET /api/stage/:code/quiz. Lazy: pass { enabled: false } until the trainee
 * actually opens the quiz, so the questions are never fetched in the
 * background.
 */
export function useQuiz(code, { enabled = true } = {}) {
  return useQuery({
    queryKey: trainingKeys.quiz(code),
    queryFn: () => fetchQuiz(code),
    enabled: Boolean(code) && enabled,
    // The questions are per-attempt state; never serve a stale copy.
    gcTime: 0,
    ...NO_RETRY,
  });
}

/**
 * POST /api/stage/:code/quiz. Call with the answers array; the server grades
 * it and the stage and track queries are refreshed from the result.
 */
export function useSubmitQuiz(code) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answers) => submitQuiz(code, answers),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trainingKeys.stage(code) });
      queryClient.invalidateQueries({ queryKey: trainingKeys.track() });
    },
  });
}
