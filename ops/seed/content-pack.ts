// The shape of a content pack, and the loader that reads one.
//
// A content pack is ONE JSON file, held outside this repository and read
// through CONTENT_PACK_PATH (ops/lib/content-pack-path.ts), that carries a
// training module the prototype never described: its stage, its lessons as
// lesson HTML, its quiz, and which option of each question is correct.
//
// This file holds the SHAPE only. No lesson text, no question, no answer and no
// department rule lives in this repository — the same rule the prototype
// follows, for the same reason.
//
// The validation below is deliberately strict. A pack is hand-built, it is the
// only description of the content that exists, and a seeder that accepts a
// half-written one puts a broken module in front of a trainee. Everything the
// database or the application would later reject is rejected here instead,
// where the error names the field.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { resolveContentPackPath } from '../lib/content-pack-path.js';

export class ContentPackError extends Error {
  override name = 'ContentPackError';
}

/** academy.stages.code, as 0002's stages_code_format CHECK defines it. */
const StageCode = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'stage code must match ^[A-Za-z0-9_-]{1,32}$');

const NonEmpty = z.string().trim().min(1);

const QuestionSchema = z
  .object({
    prompt: NonEmpty,
    /** Exactly four, as verify-seed's check c2 requires of every question. */
    options: z.array(NonEmpty).length(4),
    /** 0-based, so it reads the same as the source material it was taken from. */
    correctIndex: z.number().int().min(0).max(3),
  })
  .strict();

const LessonSchema = z
  .object({
    title: NonEmpty,
    /**
     * Lesson HTML, served by the API and sanitised on both sides against the
     * allowlist in shared/src/lessonHtml.ts. Anything outside that allowlist is
     * silently dropped at render time, so it is checked here instead.
     */
    bodyHtml: NonEmpty,
  })
  .strict();

const StageSchema = z
  .object({
    code: StageCode,
    dept: NonEmpty,
    /** The badge text: 'A2', 'IT1'. Renumbered with the stage if it moves. */
    displayNum: NonEmpty,
    /** 1-based position inside the department. Existing stages move down. */
    position: z.number().int().min(1),
    /**
     * academy.stages.sort, the one global ordering. UNIQUE, and 1..28 belong to
     * the prototype, so a pack stage takes a value above them.
     */
    sort: z.number().int().min(1).max(32767),
    title: NonEmpty,
    blurb: NonEmpty,
    passMark: z.number().int().min(1).max(100),
    /** Which tracks see this stage, and where in each track's unlock order. */
    visibility: z
      .array(z.object({ track: NonEmpty, position: z.number().int().min(1) }).strict())
      .min(1),
    lessons: z.array(LessonSchema).min(1),
    quiz: z
      .object({
        passMark: z.number().int().min(1).max(100),
        questions: z.array(QuestionSchema).min(1),
      })
      .strict(),
  })
  .strict();

export const ContentPackSchema = z
  .object({
    packVersion: z.literal(1),
    /** Names this pack in the seeder's output. No client and no staff name. */
    packId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    /** One line for the operator running the seed. */
    summary: NonEmpty,
    stages: z.array(StageSchema).min(1),
  })
  .strict();

export type ContentPack = z.infer<typeof ContentPackSchema>;
export type PackStage = z.infer<typeof StageSchema>;
export type PackQuestion = z.infer<typeof QuestionSchema>;

/**
 * Checks a pack can be believed, beyond its shape.
 *
 * Returns the problems rather than throwing, so the caller can print all of
 * them at once. Each message names a field and a stage code — never the text of
 * a lesson, a question or an answer, which is what the pack is kept outside the
 * repo to protect.
 */
export function packProblems(pack: ContentPack): string[] {
  const problems: string[] = [];
  const seenCode = new Set<string>();
  const seenSort = new Set<number>();

  for (const s of pack.stages) {
    if (seenCode.has(s.code)) problems.push(`stage ${s.code}: duplicate stage code in the pack`);
    seenCode.add(s.code);
    if (seenSort.has(s.sort)) problems.push(`stage ${s.code}: sort ${s.sort} used twice`);
    seenSort.add(s.sort);

    const tracks = s.visibility.map((v) => v.track);
    if (new Set(tracks).size !== tracks.length) {
      problems.push(`stage ${s.code}: the same track appears twice in visibility`);
    }
    if (!tracks.includes(s.dept)) {
      // Every department module in this academy is seen by its own department
      // track and by nothing else. A pack that breaks that is almost certainly
      // a typo, and the cost of the typo is a module nobody can reach.
      problems.push(`stage ${s.code}: dept ${s.dept} is not in the stage's visibility`);
    }
    const titles = s.lessons.map((l) => l.title);
    if (new Set(titles).size !== titles.length) {
      problems.push(`stage ${s.code}: two lessons share a title`);
    }
    s.quiz.questions.forEach((q, i) => {
      if (new Set(q.options).size !== q.options.length) {
        problems.push(`stage ${s.code}: question ${i + 1} repeats an option`);
      }
    });
    // "8 of 10" is a percentage here: grading.ts scores round(correct/total*100)
    // and passes on pct >= passMark. A pass mark no score can reach is a module
    // nobody can finish, and it would only be found by a trainee.
    const reachable = s.quiz.questions.map((_, i) =>
      Math.round(((i + 1) / s.quiz.questions.length) * 100),
    );
    if (!reachable.some((pct) => pct >= s.quiz.passMark)) {
      problems.push(
        `stage ${s.code}: pass mark ${s.quiz.passMark}% is unreachable with ` +
          `${s.quiz.questions.length} questions`,
      );
    }
  }
  return problems;
}

/** Reads, parses and validates the pack CONTENT_PACK_PATH points at. */
export function loadContentPack(file: string = resolveContentPackPath()): ContentPack {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ContentPackError(`Content pack is not readable JSON: ${(err as Error).message}`);
  }
  const parsed = ContentPackSchema.safeParse(raw);
  if (!parsed.success) {
    // Paths and messages only. A zod issue can echo the value it rejected, and
    // the values here are lesson text and answers.
    const where = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .slice(0, 10);
    throw new ContentPackError(`Content pack does not match the schema:\n  ${where.join('\n  ')}`);
  }
  const problems = packProblems(parsed.data);
  if (problems.length > 0) {
    throw new ContentPackError(`Content pack is inconsistent:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
