import { z } from 'zod';
import { buildSummaryPrompt } from './summaryPrompt.js';

// The ONE place that talks to a model. Everything else in the codebase sees the
// `SummaryModel` interface below, so swapping provider is this file and nothing
// else. The prompt itself is next door in summaryPrompt.ts, on purpose: it is
// the part a non-programmer needs to be able to read and change.
//
// The shape is Ollama's: POST <base>/api/chat with { model, messages, stream }
// and the answer in { message: { content } }. Two things about it are worth
// knowing before changing anything here.
//
// WHERE THE TRANSCRIPT GOES. The request body is the transcript of a real client
// call. Most of the models reachable from the configured endpoint are not local
// — the endpoint proxies them to a third party — so WHEN A CLOUD-TAGGED MODEL IS
// CONFIGURED, THE TRANSCRIPT LEAVES THE BUILDING. That is a data-protection
// decision, not a technical one, and it belongs to whoever sets
// SUMMARY_MODEL_NAME. If you need the transcript to stay on the premises, name a
// model the endpoint runs locally. Nothing in this file can tell the difference,
// which is exactly why it is written down here.
//
// WHAT IS LOGGED. Nothing that contains transcript text, and nothing that
// contains the summary. Not on success, not on failure, not in an error message
// that is later logged by somebody else. A failing HTTP endpoint loves to echo
// the request you sent it back at you, so the response body of a failure is
// never logged either: only the status, the model name and the recording id. If
// you add a log line to this file, that is the rule it has to keep.

/** How the recording is identified in a log line. Never any of its content. */
export interface SummaryRequest {
  recordingId: number;
  transcript: string;
}

export interface SummaryModel {
  /** The configured model name, stored alongside the summary it produces. */
  readonly name: string;
  /** Resolves to the summary text, or throws SummaryModelError. */
  summarise(request: SummaryRequest): Promise<string>;
}

/**
 * Anything that stopped us getting a summary: unreachable, refused, timed out,
 * or an answer we could not use. `reason` is safe to log and safe to count;
 * there is deliberately no field carrying a response body.
 */
export class SummaryModelError extends Error {
  readonly reason: 'unreachable' | 'timeout' | 'refused' | 'unusable_answer';

  constructor(reason: SummaryModelError['reason'], detail: string) {
    super(`the summary model failed (${reason}: ${detail})`);
    this.name = 'SummaryModelError';
    this.reason = reason;
  }
}

/** The bit of Ollama's /api/chat answer we use. Anything else is ignored. */
const ChatAnswerSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  /** /api/generate answers with this instead; accepted so either path works. */
  response: z.string().optional(),
});

/** What the whole feature needs from the environment, already validated. */
export interface SummaryModelSettings {
  /** SUMMARY_MODEL_URL: the BASE, e.g. http://127.0.0.1:11434 — never /api/chat. */
  baseUrl: string;
  /** SUMMARY_MODEL_NAME. */
  model: string;
  /** SUMMARY_MODEL_TIMEOUT_MS. */
  timeoutMs: number;
  /** Injected by the tests, which never call a real model. Defaults to fetch. */
  fetchImpl?: typeof fetch;
}

/** `<base>/api/chat`, whether or not the configured base ends in a slash. */
export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/chat`;
}

/**
 * The summariser. One request, no streaming, no retry.
 *
 * No retry on purpose: a failure here means nothing was saved, the endpoint says
 * so, and the trainee's button offers them another go. A silent retry inside a
 * request that somebody is waiting on would double the wait and hide the fault
 * from whoever has to fix the endpoint.
 */
export function createOllamaSummariser(settings: SummaryModelSettings): SummaryModel {
  const doFetch = settings.fetchImpl ?? fetch;
  const url = chatUrl(settings.baseUrl);

  return {
    name: settings.model,

    async summarise({ recordingId, transcript }: SummaryRequest): Promise<string> {
      const body = JSON.stringify({
        model: settings.model,
        stream: false,
        messages: [{ role: 'user', content: buildSummaryPrompt(transcript) }],
        // Low temperature: we are asking for what was said, not for prose.
        options: { temperature: 0.2 },
      });

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (err) {
        // A timeout arrives as an AbortError / TimeoutError from the signal.
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new SummaryModelError('timeout', `${String(settings.timeoutMs)}ms`);
        }
        // The message of a fetch failure is about the connection (ECONNREFUSED,
        // ENOTFOUND), not about what we sent, so it is safe to carry.
        throw new SummaryModelError('unreachable', (err as Error).message);
      }

      if (!res.ok) {
        // The status and nothing else. The body of a model endpoint's error very
        // often quotes the prompt back, which would put the transcript in the log.
        throw new SummaryModelError('refused', `HTTP ${String(res.status)}`);
      }

      let parsed: z.infer<typeof ChatAnswerSchema>;
      try {
        parsed = ChatAnswerSchema.parse(await res.json());
      } catch {
        throw new SummaryModelError('unusable_answer', 'not the expected JSON shape');
      }

      const text = (parsed.message?.content ?? parsed.response ?? '').trim();
      if (text === '') {
        throw new SummaryModelError('unusable_answer', 'empty');
      }
      // The only line this module logs. Lengths and ids, never text.
      console.log(
        `[academy-api] summarised recording ${String(recordingId)} with ${settings.model}` +
          ` (${String(transcript.length)} transcript chars in, ${String(text.length)} out)`,
      );
      return text;
    },
  };
}
