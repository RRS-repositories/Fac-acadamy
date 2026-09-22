// Reads the approved prototype (FAC-Academy-Portal-v2.5.html) and returns its
// training content as plain, validated data. Section 02 (content seed) builds
// on this; nothing here writes anywhere.
//
// How: the prototype keeps all of its content in one inline <script> as
// top-level constants (PASS_MARK, MEDIA, LEVELS, DEPTS, STATUS_GUIDE, STAGES).
// We take that data section (from `const PASS_MARK` up to `let user`, where the
// runtime code starts), plus the prototype's own CORE_IDS + visibleStage()
// source and its TRACK_DEPT map, and evaluate them in a fresh node:vm context
// that has no document, window, fetch, require or process. No DOM is needed:
// the data section only declares values and two DOM helpers that are never
// called. Track visibility is computed by running the prototype's OWN
// visibleStage(), never a re-implementation.
//
// Data hygiene: the MEDIA object holds real client call recordings as base64.
// Its values are cut out of the source before evaluation; only the file names
// (the keys) survive. Nothing in this module logs content.

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { z } from 'zod';
import { resolvePrototypePath } from '../lib/prototype-path.js';

export type TrackCode = 'FULL' | 'CS' | 'SALES' | 'ADMIN' | 'FOS' | 'MGMT' | 'PAY' | 'IT' | 'DEBT'; // same codes as shared/src/constants.ts

export interface ProtoLesson {
  title: string;
  bodyHtml: string;
}

export interface ProtoRecording {
  title: string;
  description: string;
  durationSecs: number;
  /** The prototype's `src` (embedded audio) or `videoSrc` (external video) file name; null = "to be recorded". */
  mediaFile: string | null;
  /** Addition to the agreed API: VIDEO when the prototype uses `videoSrc`, else AUDIO. */
  mediaType: 'AUDIO' | 'VIDEO';
}

export interface ProtoQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
}

export interface ProtoStage {
  id: string;
  /**
   * 1-based position in the prototype's STAGES array (its unlock/rail order).
   * For level stages this equals the prototype's own badge number (1..16);
   * department modules carry a text badge ("A1", "IT2"), see displayNum.
   */
  num: number;
  /** Addition to the agreed API: the prototype's badge text, e.g. "1", "A1", "IT2". */
  displayNum: string;
  /** 1..5 for level stages; null for department modules (the prototype uses level 0). */
  level: number | null;
  /** Department code for department modules, else null. */
  dept: string | null;
  title: string;
  blurb: string;
  /** Resolved by the prototype's own pm(): s.passMark || PASS_MARK. */
  passMark: number;
  lessons: ProtoLesson[];
  recordings: ProtoRecording[];
  quiz: ProtoQuestion[];
}

export interface ProtoLevel {
  n: number;
  name: string;
  weeks: string;
  accomplishment: string;
  desc: string;
}

export interface ProtoDept {
  code: string;
  name: string;
  icon: string;
  accomplishment: string;
  desc: string;
}

export interface ProtoStatus {
  status: string;
  clientLine: string;
  sort: number;
}

export interface PrototypeData {
  passMark: number;
  levels: ProtoLevel[];
  depts: ProtoDept[];
  statusGuide: ProtoStatus[];
  stages: ProtoStage[];
  /** Keys of the prototype's MEDIA object (embedded recordings). File names only, never the data. */
  mediaFiles: string[];
  visibleStageIds(track: TrackCode): string[];
}

/** Track code → the track name the prototype's sign-in form and visibleStage() use. */
export const PROTOTYPE_TRACK_NAMES: Readonly<Record<TrackCode, string>> = {
  FULL: 'Full Programme',
  CS: 'Customer Service',
  SALES: 'Sales',
  ADMIN: 'Admin',
  FOS: 'Financial Ombudsman',
  MGMT: 'Management',
  PAY: 'Payments',
  IT: 'IT',
  DEBT: 'Debt Collections',
};

export const TRACK_CODES_IN_ORDER: readonly TrackCode[] = [
  'FULL',
  'CS',
  'SALES',
  'ADMIN',
  'FOS',
  'MGMT',
  'PAY',
  'IT',
  'DEBT',
];

/** A shape or structure problem in the prototype. Messages carry ids and counts only. */
export class PrototypeError extends Error {
  override name = 'PrototypeError';
}

// ---------------------------------------------------------------------------
// Raw shapes, exactly as the prototype writes them. `.strict()` everywhere:
// an unexpected key is a shape surprise and must stop the seed.
// ---------------------------------------------------------------------------
const text = z.string().min(1);

const RawLesson = z.object({ t: text, body: text }).strict();

const RawRecording = z
  .object({
    t: text,
    d: z.string(),
    len: z.number().int().positive(),
    src: text.optional(),
    videoSrc: text.optional(),
  })
  .strict()
  .refine((r) => !(r.src && r.videoSrc), { message: 'recording has both src and videoSrc' });

const RawQuestion = z
  .object({
    q: text,
    o: z.array(text).min(2),
    a: z.number().int().min(0),
  })
  .strict()
  .refine((x) => x.a < x.o.length, { message: 'answer index is outside the options' });

export const RawStageSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    num: z.union([z.number().int().positive(), text]),
    level: z.number().int().min(0).max(20),
    dept: text.optional(),
    title: text,
    blurb: text,
    passMark: z.number().int().min(1).max(100).optional(),
    lessons: z.array(RawLesson).min(1),
    recordings: z.array(RawRecording),
    quiz: z.array(RawQuestion).min(1),
  })
  .strict()
  .refine((s) => (s.dept ? s.level === 0 : s.level >= 1), {
    message: 'a department module must have level 0; a level stage must have level >= 1',
  });

const RawLevel = z
  .object({
    n: z.number().int().positive(),
    name: text,
    weeks: text,
    accomplishment: text,
    desc: text,
  })
  .strict();

const RawDept = z
  .object({
    code: z.string().regex(/^[A-Z]{2,10}$/),
    name: text,
    icon: text,
    accomplishment: text,
    desc: text,
  })
  .strict();

const RawExtract = z.object({
  passMark: z.number().int().min(1).max(100),
  mediaKeys: z.array(text),
  levels: z.array(RawLevel).min(1),
  depts: z.array(RawDept).min(1),
  statusGuide: z.array(z.tuple([text, text])).min(1),
  stages: z.array(RawStageSchema).min(1),
  resolvedPassMarks: z.array(z.number().int().min(1).max(100)),
  trackDept: z.record(z.string(), z.string()),
});

type RawExtract = z.infer<typeof RawExtract>;

function zodFail(what: string, err: z.ZodError): never {
  // Paths and messages only: never the offending values (they are content).
  const issues = err.issues
    .slice(0, 10)
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new PrototypeError(`${what} failed validation:\n${issues}`);
}

// ---------------------------------------------------------------------------
// Source extraction
// ---------------------------------------------------------------------------

/** The single inline <script> that declares STAGES. */
export function findDataScript(html: string): string {
  const scripts: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? '';
    if (/\ssrc\s*=/i.test(attrs)) continue;
    if (/^\s*const STAGES\s*=/m.test(m[2] ?? '')) scripts.push(m[2] ?? '');
  }
  if (scripts.length !== 1) {
    throw new PrototypeError(
      `Expected exactly one inline <script> declaring STAGES, found ${scripts.length}.`,
    );
  }
  return scripts[0]!;
}

function indexOfLine(src: string, re: RegExp, from = 0, what = re.source): number {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags.includes('m') ? flags : flags + 'm');
  g.lastIndex = from;
  const m = g.exec(src);
  if (!m) throw new PrototypeError(`Prototype script: could not find ${what}.`);
  return m.index;
}

/**
 * Replaces `const MEDIA = { "file": "data:...", ... };` with an object of the
 * same keys and empty values, so the base64 never reaches the sandbox or the
 * result. Returns the rewritten source and the keys.
 */
export function stripMedia(section: string): { source: string; keys: string[] } {
  const start = indexOfLine(section, /^const MEDIA\s*=\s*\{/, 0, '`const MEDIA = {`');
  let i = section.indexOf('{', start) + 1;
  const keys: string[] = [];
  const fail = (why: string): never => {
    throw new PrototypeError(`Prototype MEDIA object: ${why}.`);
  };
  for (;;) {
    while (i < section.length && /[\s,]/.test(section[i]!)) i++;
    if (section[i] === '}') break;
    if (section[i] !== '"') fail('expected a quoted file name');
    const keyEnd = section.indexOf('"', i + 1);
    if (keyEnd < 0) fail('unterminated file name');
    keys.push(section.slice(i + 1, keyEnd));
    i = keyEnd + 1;
    while (/\s/.test(section[i] ?? '')) i++;
    if (section[i] !== ':') fail('expected ":" after a file name');
    i++;
    while (/\s/.test(section[i] ?? '')) i++;
    if (section[i] !== '"') fail('expected a quoted data URL');
    const valEnd = section.indexOf('"', i + 1);
    if (valEnd < 0) fail('unterminated data URL');
    if (!section.startsWith('data:', i + 1)) fail('a value is not a data: URL');
    i = valEnd + 1;
  }
  let end = i + 1;
  while (/\s/.test(section[end] ?? '')) end++;
  if (section[end] === ';') end++;
  const emptied = `const MEDIA = ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, ''])))};`;
  return { source: section.slice(0, start) + emptied + section.slice(end), keys };
}

/** Index just past the `}` that closes the `{` at `open`. Skips strings and comments. */
export function matchBrace(src: string, open: number): number {
  if (src[open] !== '{') throw new PrototypeError('matchBrace: not at "{".');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 1;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new PrototypeError('matchBrace: unbalanced braces.');
}

/** `const CORE_IDS = [...]; function visibleStage(st){...}`, verbatim. */
export function extractVisibility(script: string): string {
  const start = indexOfLine(script, /^const CORE_IDS\s*=/, 0, '`const CORE_IDS =`');
  const fn = indexOfLine(script, /^function visibleStage\s*\(/, start, '`function visibleStage(`');
  return script.slice(start, matchBrace(script, script.indexOf('{', fn)));
}

/** The object literal of `const TRACK_DEPT = {...};` (declared inside the sign-in handler). */
export function extractTrackDept(script: string): string {
  const m = /\bconst TRACK_DEPT\s*=\s*(\{[^{}]*\})\s*;/.exec(script);
  if (!m?.[1])
    throw new PrototypeError('Prototype script: could not find `const TRACK_DEPT = {...}`.');
  return m[1];
}

/** Option values of the sign-in form's track <select id="fTrack">. */
export function extractTrackNames(html: string): string[] {
  const m = /<select[^>]*\bid="fTrack"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!m?.[1]) throw new PrototypeError('Prototype: could not find <select id="fTrack">.');
  return [...m[1].matchAll(/<option[^>]*\bvalue="([^"]*)"/gi)].map((o) => o[1] ?? '');
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

interface Sandbox {
  extract(): unknown;
  visible(user: { track: string; deptTrack: string | null; role: string }): string[];
}

function runSandbox(dataSection: string, visibility: string, trackDept: string): Sandbox {
  const program = [
    // Globals the data section and visibleStage() read. Values as in v2.5.
    'let RECORDINGS_ENABLED = true;',
    'let user = null;',
    dataSection,
    ';',
    visibility,
    ';',
    `const TRACK_DEPT = ${trackDept};`,
    'globalThis.__extract = () => JSON.stringify({',
    '  passMark: PASS_MARK, mediaKeys: Object.keys(MEDIA), levels: LEVELS, depts: DEPTS,',
    '  statusGuide: STATUS_GUIDE, stages: STAGES, resolvedPassMarks: STAGES.map(pm),',
    '  trackDept: TRACK_DEPT,',
    '});',
    'globalThis.__visible = (u) => {',
    '  user = JSON.parse(u); RECORDINGS_ENABLED = true;',
    '  return JSON.stringify(STAGES.filter(visibleStage).map((s) => s.id));',
    '};',
  ].join('\n');

  // Empty context: no document, window, fetch, require, process or timers.
  const context = vm.createContext(Object.create(null) as object, {
    name: 'fac-prototype',
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new vm.Script(program, { filename: 'prototype-data.js' }).runInContext(context, {
      timeout: 10_000,
    });
  } catch (err) {
    throw new PrototypeError(
      `Evaluating the prototype data section failed: ${(err as Error).message}`,
    );
  }
  const g = context as { __extract?: () => string; __visible?: (u: string) => string };
  const { __extract: extractFn, __visible: visibleFn } = g;
  if (typeof extractFn !== 'function' || typeof visibleFn !== 'function') {
    throw new PrototypeError('Sandbox did not expose its helpers.');
  }
  return {
    extract: () => JSON.parse(extractFn()) as unknown,
    visible: (user) => {
      const ids = JSON.parse(visibleFn(JSON.stringify(user))) as unknown;
      return z.array(z.string()).parse(ids);
    },
  };
}

// ---------------------------------------------------------------------------
// Normalise
// ---------------------------------------------------------------------------

function normalise(raw: RawExtract): Omit<PrototypeData, 'visibleStageIds'> {
  const ids = new Set<string>();
  for (const s of raw.stages) {
    if (ids.has(s.id)) throw new PrototypeError(`Duplicate stage id ${s.id}.`);
    ids.add(s.id);
  }
  if (raw.resolvedPassMarks.length !== raw.stages.length) {
    throw new PrototypeError('pm() did not return one pass mark per stage.');
  }
  const levelNs = new Set(raw.levels.map((l) => l.n));
  const deptCodes = new Set(raw.depts.map((d) => d.code));
  const mediaKeys = new Set(raw.mediaKeys);

  const stages: ProtoStage[] = raw.stages.map((s, idx) => {
    if (s.dept && !deptCodes.has(s.dept)) {
      throw new PrototypeError(`Stage ${s.id}: department ${s.dept} is not in DEPTS.`);
    }
    if (!s.dept && !levelNs.has(s.level)) {
      throw new PrototypeError(`Stage ${s.id}: level ${s.level} is not in LEVELS.`);
    }
    return {
      id: s.id,
      num: idx + 1,
      displayNum: String(s.num),
      level: s.dept ? null : s.level,
      dept: s.dept ?? null,
      title: s.title,
      blurb: s.blurb,
      passMark: raw.resolvedPassMarks[idx]!,
      lessons: s.lessons.map((l) => ({ title: l.t, bodyHtml: l.body })),
      recordings: s.recordings.map((r, ri) => {
        if (r.src && !mediaKeys.has(r.src)) {
          throw new PrototypeError(`Stage ${s.id} recording ${ri + 1}: src is not a MEDIA key.`);
        }
        return {
          title: r.t,
          description: r.d,
          durationSecs: r.len,
          mediaFile: r.src ?? r.videoSrc ?? null,
          mediaType: r.videoSrc ? ('VIDEO' as const) : ('AUDIO' as const),
        };
      }),
      quiz: s.quiz.map((q) => ({ prompt: q.q, options: [...q.o], correctIndex: q.a })),
    };
  });

  const statuses = new Set<string>();
  const statusGuide = raw.statusGuide.map(([status, clientLine], i) => {
    if (statuses.has(status)) throw new PrototypeError(`Duplicate STATUS_GUIDE entry #${i + 1}.`);
    statuses.add(status);
    return { status, clientLine, sort: i + 1 };
  });

  return {
    passMark: raw.passMark,
    levels: raw.levels.map((l) => ({ ...l })),
    depts: raw.depts.map((d) => ({ ...d })),
    statusGuide,
    stages,
    mediaFiles: [...raw.mediaKeys],
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parses prototype HTML (the full file text). Exported for tests with synthetic fixtures. */
export function parsePrototypeHtml(html: string): PrototypeData {
  const script = findDataScript(html);
  const start = indexOfLine(script, /^const PASS_MARK\s*=/, 0, '`const PASS_MARK =`');
  const stagesAt = indexOfLine(script, /^const STAGES\s*=/, start, '`const STAGES =`');
  const end = indexOfLine(script, /^let user\s*=/, stagesAt, '`let user =` after STAGES');
  const { source: dataSection } = stripMedia(script.slice(start, end));

  const sandbox = runSandbox(dataSection, extractVisibility(script), extractTrackDept(script));
  const parsed = RawExtract.safeParse(sandbox.extract());
  if (!parsed.success) zodFail('Prototype data', parsed.error);
  const data = normalise(parsed.data);

  // The sign-in form must offer exactly the nine tracks we know.
  const formNames = extractTrackNames(html);
  const ours = TRACK_CODES_IN_ORDER.map((c) => PROTOTYPE_TRACK_NAMES[c]);
  if (formNames.length !== ours.length || !ours.every((n) => formNames.includes(n))) {
    throw new PrototypeError(
      `The prototype's track list (${formNames.length} options) does not match the 9 known tracks.`,
    );
  }

  // TRACK_DEPT must map each department track to its own code.
  const trackDept = parsed.data.trackDept;
  const visible = new Map<TrackCode, string[]>();
  const stageIds = new Set(data.stages.map((s) => s.id));
  for (const code of TRACK_CODES_IN_ORDER) {
    const name = PROTOTYPE_TRACK_NAMES[code];
    const deptTrack = trackDept[name] ?? null;
    const isDeptTrack = data.depts.some((d) => d.code === code);
    if (isDeptTrack ? deptTrack !== code : deptTrack !== null) {
      throw new PrototypeError(`TRACK_DEPT maps track ${code} unexpectedly.`);
    }
    const ids = sandbox.visible({ track: name, deptTrack, role: 'staff' });
    if (ids.length === 0) throw new PrototypeError(`Track ${code} sees no stages.`);
    for (const id of ids) {
      if (!stageIds.has(id)) throw new PrototypeError(`Track ${code}: unknown stage ${id}.`);
    }
    visible.set(code, ids);
  }

  return {
    ...data,
    visibleStageIds(track: TrackCode): string[] {
      const ids = visible.get(track);
      if (!ids) throw new PrototypeError(`Unknown track code ${String(track)}.`);
      return [...ids];
    },
  };
}

export async function loadPrototype(path?: string): Promise<PrototypeData> {
  const file = path ?? resolvePrototypePath();
  return parsePrototypeHtml(await readFile(file, 'utf8'));
}
