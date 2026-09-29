// THE PROMPT. This is the whole of what we ask a model to do, in one file, so
// that it can be read and changed by somebody who is not going to read the HTTP
// code next door in summaryModel.ts.
//
// Read this before changing it:
//
//  * What goes in is the TRANSCRIPT of a real client call. What comes out is
//    shown to trainees underneath the player as a convenience — it never
//    replaces listening, and it is not training content: the approved
//    prototype's lessons and quizzes are the training content, and nothing a
//    model writes is allowed near them.
//
//  * It summarises WHAT WAS SAID ON THE CALL. Not the lesson the recording sits
//    in, not the stage, not the track. Transcript in, summary out.
//
//  * It deliberately does NOT ask the model to judge how the agent performed,
//    score the call, or suggest what they should have said. Assessing a
//    colleague is a manager's job, and putting a model's opinion of a named
//    colleague's work in front of the trainees who sit next to them would be
//    unfair and would be read as the company's view. If somebody later wants
//    coaching feedback, that is a separate feature with a manager in the loop,
//    not two more words in this prompt.
//
//  * No persona. The model is not "an expert claims coach"; it is a thing that
//    writes a short factual summary. A persona buys nothing here and invites
//    invention.

/**
 * The most transcript characters we send. A 17-minute call is roughly 20,000
 * characters, so this covers every recording in the library today with room to
 * spare, and it stops one very long file turning into a request no endpoint will
 * accept. When it bites, the model is TOLD the text was cut short rather than
 * being left to summarise a call that appears to stop mid-sentence.
 */
export const SUMMARY_TRANSCRIPT_CHAR_LIMIT = 40_000;

/** The transcript as it is sent, and whether anything was left off. */
export function prepareTranscript(transcript: string): { text: string; truncated: boolean } {
  const text = transcript.trim();
  if (text.length <= SUMMARY_TRANSCRIPT_CHAR_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, SUMMARY_TRANSCRIPT_CHAR_LIMIT), truncated: true };
}

/**
 * The instruction. Plain professional English, because staff read the result.
 *
 * "Only what the transcript says" is the line that matters most: a summary that
 * invents a detail about a real client's case is worse than no summary, and a
 * trainee has no way to tell the difference without listening to the whole call
 * — which is the very thing they are using this to avoid doing twice.
 */
export const SUMMARY_INSTRUCTION = [
  'You are summarising the transcript of a recorded telephone call so that a',
  'member of staff can see at a glance what the call was about before they',
  'listen to it.',
  '',
  'Write:',
  '  1. One sentence saying what the call was about.',
  '  2. Then three to six short bullet points, each starting with "- ", covering',
  '     what was discussed, what was asked, what was agreed, and how the call',
  '     ended.',
  '',
  'Rules:',
  '  - Use only what the transcript says. If something is unclear or was not',
  '    said, leave it out. Never guess, and never fill a gap with what usually',
  '    happens on a call like this.',
  '  - Do not assess, score or comment on how well anyone handled the call, and',
  '    do not suggest what they should have said. Say what happened, nothing more.',
  '  - Plain professional English. No headings, no preamble such as "Here is a',
  '    summary", no closing remark, and no markdown other than the bullet dashes.',
  '  - Keep the whole thing under 200 words.',
].join('\n');

/**
 * The message the model is sent: the instruction, then the transcript, clearly
 * fenced so a line inside the call cannot be read as a further instruction.
 */
export function buildSummaryPrompt(transcript: string): string {
  const { text, truncated } = prepareTranscript(transcript);
  const parts = [SUMMARY_INSTRUCTION, '', 'TRANSCRIPT BEGINS', text, 'TRANSCRIPT ENDS'];
  if (truncated) {
    parts.push(
      '',
      'Note: the transcript above was cut short because the recording is long.',
      'Summarise only the part you were given, and do not speculate about the rest.',
    );
  }
  return parts.join('\n');
}
