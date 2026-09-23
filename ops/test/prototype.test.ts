// Unit tests for ops/seed/prototype.ts against a tiny INVENTED prototype.
// Nothing here comes from the real prototype: every string is made up.
import { describe, expect, it } from 'vitest';
import { classifyStage, mediaKeyFor, recordingCode } from '../seed/seed-content.js';
import {
  parsePrototypeHtml,
  PrototypeError,
  TRACK_CODES_IN_ORDER,
  type PrototypeData,
} from '../seed/prototype.js';

const FAKE_BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';

const TRACK_OPTIONS = [
  'Full Programme',
  'Customer Service',
  'Sales',
  'Admin',
  'Financial Ombudsman',
  'Management',
  'Payments',
  'IT',
  'Debt Collections',
]
  .map((t) => `<option value="${t}">${t}</option>`)
  .join('');

const BT = '`';

const STAGE_S1 = `{
  id:"s1", num:1, level:1, title:"Stage A",
  blurb:"Blurb A",
  lessons:[
    {t:"Lesson A", body:${BT}
      <p>Lesson A body with "quotes" and a } brace.</p>${BT}},
    {t:"Lesson B", body:${BT}<p>Lesson B body</p>${BT}}
  ],
  recordings:[
    {t:"Recording A", d:"Placeholder A", len:120}
  ],
  quiz:[
    {q:"Question A?", o:["Option 1","Option 2","Option 3","Option 4"], a:2},
    {q:"Question B?", o:["Option 1","Option 2","Option 3","Option 4"], a:0}
  ]
}`;

const STAGE_S4 = `{
  id:"s4", num:2, level:1, title:"Stage B", blurb:"Blurb B", passMark:90,
  lessons:[{t:"Lesson C", body:${BT}<p>Lesson C body</p>${BT}}],
  recordings:[
    {t:"Recording B", d:"Real B", len:300, src:"fake_1.mp3"},
    {t:"Recording C", d:"Placeholder C", len:60}
  ],
  quiz:[{q:"Question C?", o:["Option 1","Option 2","Option 3","Option 4"], a:3}]
}`;

const STAGE_DA1 = `{
  id:"dA1", num:"A1", dept:"ADMIN", level:0, title:"Module A", blurb:"Blurb C",
  lessons:[{t:"Lesson D", body:${BT}<p>Lesson D body</p>${BT}}],
  recordings:[{t:"Video A", d:"Walkthrough A", len:900, videoSrc:"fake_video.mp4"}],
  quiz:[{q:"Question D?", o:["Option 1","Option 2","Option 3","Option 4"], a:1}]
}`;

interface FixtureOptions {
  passMark?: number;
  stages?: string[];
  salesRule?: string;
  extraData?: string;
}

function fixture(opts: FixtureOptions = {}): string {
  const stages = opts.stages ?? [STAGE_S1, STAGE_S4, STAGE_DA1];
  const salesRule = opts.salesRule ?? 'return st.id!=="s4";';
  return `<!doctype html><html><head><title>Invented fixture</title>
<script src="https://example.invalid/lib.js"></script></head><body>
<select id="fTrack">${TRACK_OPTIONS}</select>
<script>
let PREVIEW_MODE = true;
let RECORDINGS_ENABLED = true;

const PASS_MARK = ${opts.passMark ?? 80};
const MEDIA = {
"fake_1.mp3":"data:audio/mpeg;base64,${FAKE_BASE64}",
"fake_2.mp3":"data:audio/mpeg;base64,${FAKE_BASE64}"
};

const pm = s => s.passMark || PASS_MARK;

const LEVELS = [
  {n:1, name:"Level One", weeks:"Week 1", accomplishment:"Done one", desc:"Level one text."}
];
const DEPTS = [
  {code:"ADMIN", name:"Admin Academy", icon:"A", accomplishment:"Certified A", desc:"Dept text."}
];
const STATUS_GUIDE = [
 ["Status A","Client line A."],
 ["Status B","Client line B."]
];
function showDsar(which){ var g=document.getElementById('x'); g.style.display='none'; }
${opts.extraData ?? ''}
const STAGES = [
${stages.join(',\n')}
];

/* ---- STATE ---- */
let user = null;
function doLogin(){
  const TRACK_DEPT = {"Admin":"ADMIN"};
  user = { track: "x", deptTrack: TRACK_DEPT["x"] || null, role:"staff" };
}
const CORE_IDS = ["s1"];
function visibleStage(st){
  if(!RECORDINGS_ENABLED && st.id==="s4") return false;
  if(!user || user.role==="manager") return true;
  if(user.deptTrack){               // a { brace in a comment
    if(st.dept) return st.dept===user.deptTrack;
    return CORE_IDS.includes(st.id);
  }
  if(st.dept) return false;
  if(user.track==="Sales") { ${salesRule} }
  return true;
}
document.getElementById("main").innerHTML = "runtime code the loader must never run";
</script></body></html>`;
}

describe('parsePrototypeHtml (invented fixture)', () => {
  const data: PrototypeData = parsePrototypeHtml(fixture());

  it('extracts levels, departments, the status guide and stages', () => {
    expect(data.passMark).toBe(80);
    expect(data.levels).toEqual([
      {
        n: 1,
        name: 'Level One',
        weeks: 'Week 1',
        accomplishment: 'Done one',
        desc: 'Level one text.',
      },
    ]);
    expect(data.depts.map((d) => d.code)).toEqual(['ADMIN']);
    expect(data.statusGuide).toEqual([
      { status: 'Status A', clientLine: 'Client line A.', sort: 1 },
      { status: 'Status B', clientLine: 'Client line B.', sort: 2 },
    ]);
    expect(data.stages.map((s) => s.id)).toEqual(['s1', 's4', 'dA1']);
    const [s1, , dA1] = data.stages;
    expect(s1?.lessons.map((l) => l.title)).toEqual(['Lesson A', 'Lesson B']);
    expect(s1?.lessons[0]?.bodyHtml).toBe(
      '\n      <p>Lesson A body with "quotes" and a } brace.</p>',
    );
    expect(s1?.quiz[0]).toEqual({
      prompt: 'Question A?',
      options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'],
      correctIndex: 2,
    });
    expect(s1).toMatchObject({ num: 1, displayNum: '1', level: 1, dept: null });
    expect(dA1).toMatchObject({ num: 3, displayNum: 'A1', level: null, dept: 'ADMIN' });
  });

  it('resolves pass marks with the prototype pm(): stage value, else PASS_MARK', () => {
    expect(data.stages.map((s) => s.passMark)).toEqual([80, 90, 80]);
    const other = parsePrototypeHtml(fixture({ passMark: 75 }));
    expect(other.passMark).toBe(75);
    expect(other.stages.map((s) => s.passMark)).toEqual([75, 90, 75]);
  });

  it("computes visibility with the prototype's own visibleStage()", () => {
    expect(data.visibleStageIds('FULL')).toEqual(['s1', 's4']);
    expect(data.visibleStageIds('SALES')).toEqual(['s1']);
    expect(data.visibleStageIds('ADMIN')).toEqual(['s1', 'dA1']);
    // Change the rule inside the fixture: the result follows the fixture, so
    // the loader runs the embedded function rather than a copy of the rule.
    const changed = parsePrototypeHtml(fixture({ salesRule: 'return true;' }));
    expect(changed.visibleStageIds('SALES')).toEqual(['s1', 's4']);
    for (const t of TRACK_CODES_IN_ORDER) expect(data.visibleStageIds(t).length).toBeGreaterThan(0);
  });

  it('keeps media file names but never the base64', () => {
    expect(data.mediaFiles).toEqual(['fake_1.mp3', 'fake_2.mp3']);
    const recs = data.stages.flatMap((s) => s.recordings);
    expect(recs.map((r) => [r.mediaFile, r.mediaType])).toEqual([
      [null, 'AUDIO'],
      ['fake_1.mp3', 'AUDIO'],
      [null, 'AUDIO'],
      ['fake_video.mp4', 'VIDEO'],
    ]);
    const json = JSON.stringify(data);
    expect(json).not.toContain(FAKE_BASE64);
    expect(json).not.toContain('base64');
    expect(json).not.toContain('data:audio');
  });

  it('rejects a malformed stage with a validation error', () => {
    const noTitle = STAGE_S4.replace('title:"Stage B", ', '');
    expect(() => parsePrototypeHtml(fixture({ stages: [STAGE_S1, noTitle] }))).toThrow(
      /failed validation[\s\S]*stages\.1\.title/,
    );
    const badAnswer = STAGE_S4.replace('a:3}', 'a:7}');
    expect(() => parsePrototypeHtml(fixture({ stages: [STAGE_S1, badAnswer] }))).toThrow(
      PrototypeError,
    );
    const extraKey = STAGE_S4.replace('blurb:"Blurb B",', 'blurb:"Blurb B", surprise:true,');
    expect(() => parsePrototypeHtml(fixture({ stages: [STAGE_S1, extraKey] }))).toThrow(
      /stages\.1/,
    );
  });

  it('does not echo content in validation errors', () => {
    const bad = STAGE_S4.replace('a:3}', 'a:"Invented answer text"}');
    expect(() => parsePrototypeHtml(fixture({ stages: [STAGE_S1, bad] }))).toThrow(PrototypeError);
    try {
      parsePrototypeHtml(fixture({ stages: [STAGE_S1, bad] }));
    } catch (err) {
      expect((err as Error).message).not.toContain('Invented answer text');
    }
  });

  it('evaluates in a sandbox with no DOM or Node globals', () => {
    const probe = 'const __probe = document.title;';
    expect(() => parsePrototypeHtml(fixture({ extraData: probe }))).toThrow(
      /document is not defined/,
    );
    const req = 'const __probe = require("node:fs");';
    expect(() => parsePrototypeHtml(fixture({ extraData: req }))).toThrow(/require is not defined/);
    const proc = 'const __probe = process.env;';
    expect(() => parsePrototypeHtml(fixture({ extraData: proc }))).toThrow(
      /process is not defined/,
    );
  });
});

describe('seed mapping helpers', () => {
  const data = parsePrototypeHtml(fixture());

  it('maps stages to legacy track and recording category from visibility', () => {
    const [s1, s4, dA1] = data.stages;
    expect(classifyStage(s1!, data)).toEqual({ track: 'FULL', category: 'INDUCTION' });
    // In the fixture, s4 is hidden from Sales only, so it is a CS stage.
    expect(classifyStage(s4!, data)).toEqual({ track: 'CS', category: 'CUSTOMER_SERVICE' });
    expect(classifyStage(dA1!, data)).toEqual({ track: 'ADMIN', category: 'DEPARTMENT' });
  });

  it('builds stable recording codes and S3 keys', () => {
    expect(recordingCode('s4', 1)).toBe('s4-rec1');
    expect(mediaKeyFor('fake_1.mp3')).toBe('academy/media/fake_1.mp3');
  });
});
