#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper and print JSON on stdout.

    python transcribe.py --file <path> --model small

It prints ONE JSON object and nothing else:

    {"segments": [{"start": 0.0, "end": 4.32, "text": "...", "speaker": "A"}],
     "language": "en", "duration": 521.4, "model": "small",
     "speakers": {"labelled": true, "method": "channel-energy", "unknown": 14}}

Everything else — progress, warnings, tracebacks — goes to stderr, because
stdout is a machine-readable channel that server/src/media/transcriber.ts parses.

Deliberately small. It takes a path and a model name, it runs the model, it
prints the result. No database, no network, no configuration file, no logging to
disk, and no defaults worth arguing about: the caller decides the model, because
which one ships is still being judged from real transcripts.

THE AUDIO NEVER LEAVES THIS MACHINE. faster-whisper runs the model locally from a
file on local disk. That is the entire reason transcription is done on our own
hardware rather than through a service: these are real client calls.

NOTHING HERE PRINTS A WORD THAT WAS SAID, except as part of the one JSON object
on stdout. Not to stderr, not on a failure, not as progress. stderr ends up in a
terminal scrollback and in the worker's log; a transcript belongs in the database
and on the screen of somebody who could already play the recording.
"""

import argparse
import json
import os
import sys

# ---------------------------------------------------------------------------
# The vocabulary prompt — SHORT, AND SHORT ON PURPOSE
# ---------------------------------------------------------------------------
#
# WHY THERE IS A PROMPT AT ALL: without one, every model size renders the firm's
# central phrase, "irresponsible lending", as "irresponsible ending". That is the
# one error worth spending anything on, because it is the name of the thing the
# whole company does and it is wrong on nearly every call.
#
# WHY IT IS ONLY ABOUT FORTY TOKENS, AND MUST STAY THAT WAY: the trial (28 Sep
# 2026) measured a LONGER prompt — the full lender list, the compliance phrases —
# combined with `hotwords`. It silently DROPPED 24% of the spoken content:
# 1461 words against 1925, three minutes of the call reduced to about two thirds
# of their seconds each, and half of the compliance script simply missing. A long
# prompt does not merely fail to help; it steers the decoder away from what was
# actually said, and it does so quietly, which is the worst possible failure for a
# transcript somebody is going to read while they listen.
#
# A wrong lender name is a small, visible error that a trainee reads straight
# past. A missing minute of a compliance script is invisible and could mislead.
# So: name the firm, name the phrase that is always wrong, name a handful of the
# commonest lenders, and stop. If you are tempted to add to this list, measure the
# coverage figures in ops/media/transcribe.ts before and after — that is the
# number the long prompt wrecked.
INITIAL_PROMPT = (
    "Rowan Rose Solicitors. An irresponsible lending claim. "
    "Lenders: Vanquis, Aqua, Capital One, MBNA, Marbles, H&T Pawnbrokers. "
    "A letter of authority, no win no fee."
)

# ---------------------------------------------------------------------------
# Speaker labels from channel energy — no machine learning
# ---------------------------------------------------------------------------
#
# The call recordings are TRUE DUAL-CHANNEL: the agent is on one channel and the
# client on the other, because that is how the telephony system records them.
# Measured across every audio recording we hold (28 Sep 2026): two channels, the
# two never identical, left/right correlation between -0.0007 and +0.0013 — in
# other words no relationship at all — and only 1-4% of the speaking seconds where
# the two channels are within 1.3x of each other.
#
# That makes "who is talking" a question about ENERGY, not about voices. Comparing
# the loudness of the two channels over a segment labelled 95% of the segments of
# the trial call, and the 5% it would not label were left unlabelled rather than
# guessed. No diarisation model, no pyannote, no second pass over the audio, and
# nothing that could be wrong in an interesting way.
#
# THE LABELS ARE 'A' AND 'B' — the left channel and the right channel — and NOT
# 'Agent' and 'Client'. Which side the agent sits on is a property of the phone
# system, not of the audio, and it is not the same on every recording we hold: on
# most the busier speaker is on the left, on one of them the right. Deciding "the
# one who talks more is the agent" would be a guess that reads as a fact, and a
# transcript that confidently attributes the compliance script to the client is
# worse than one that says "Speaker 1".
SAMPLE_RATE = 16000

# Louder than this multiple of the other channel counts as that channel's speaker.
# From the trial: at 1.3x, 5% of segments were left unlabelled and the rest matched
# a manual read of who was speaking.
DOMINANCE_RATIO = 1.3

# The straddle check. A segment that begins in the agent's answer and ends in the
# client's reply has decisive-looking total energy and no single speaker. So the
# segment is also examined in short frames, and if the quieter side owns more than
# STRADDLE_SHARE of the frames that have any speech in them, the segment is left
# unlabelled — it belongs to both.
FRAME_SECS = 0.4
STRADDLE_SHARE = 0.25

# A frame counts as speech if it is above this fraction of the loudest frame in
# the same segment, with an absolute floor for a segment that is nearly silent.
# Relative, because recording levels differ by a factor of ten between files.
FRAME_FLOOR_SHARE = 0.20
FRAME_FLOOR_ABS = 40.0

# Whether the FILE can be labelled at all. Every one of these is a measured
# property of our recordings with a wide margin, and a file that fails any of them
# gets NO labels rather than nonsense ones — a mono file, a file mixed down to one
# track, or a file where one side is silent has no per-channel speaker to find.
MAX_CORRELATION = 0.10  # measured: |corr| <= 0.0013 on every recording
MAX_COMPARABLE_SHARE = 0.20  # measured: 0.01-0.04 of speaking seconds
MIN_MINORITY_SHARE = 0.10  # measured: the quieter speaker holds 0.22-0.43


def _log(message: str) -> None:
    """Progress, to stderr. Counts and seconds only — never a word that was said."""
    print(f"[transcribe] {message}", file=sys.stderr, flush=True)


def load_channels(path: str):
    """The two channels as float arrays at 16 kHz, or None and the reason why not.

    Returns (left, right, "") on success and (None, None, reason) when this file
    cannot be labelled. A reason is a short phrase for the operator; it never
    contains anything that was said.
    """
    try:
        import av  # a dependency of faster-whisper itself, so it is already here
        import numpy as np
    except ImportError as err:  # pragma: no cover - depends on the installation
        return None, None, f"no audio decoder ({err})"

    left = []
    right = []
    try:
        # try/finally, not `close()` at the end: every early return below is a file
        # we have decided not to label, and on Windows an unclosed container keeps
        # the media file locked — so the next thing to touch that recording (a
        # re-run, the player, a tidy-up) would fail for a reason nothing explains.
        container = av.open(path)
        try:
            streams = container.streams.audio
            if not streams:
                return None, None, "no audio stream"
            native = streams[0].codec_context.layout.nb_channels
            if native < 2:
                # A mono file has one track and therefore one energy reading.
                # There is nothing to compare, and inventing a comparison would
                # label every segment as the same speaker.
                return None, None, f"{native} channel(s), not dual-channel"

            resampler = av.AudioResampler(format="s16", layout="stereo", rate=SAMPLE_RATE)
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    block = out.to_ndarray().reshape(-1, 2)
                    left.append(block[:, 0])
                    right.append(block[:, 1])
            for out in resampler.resample(None):  # flush the resampler's tail
                block = out.to_ndarray().reshape(-1, 2)
                left.append(block[:, 0])
                right.append(block[:, 1])
        finally:
            container.close()
    except Exception as err:  # pragma: no cover - a broken or exotic file
        return None, None, f"could not decode the channels ({type(err).__name__})"

    if not left:
        return None, None, "no audio decoded"
    l_arr = np.concatenate(left).astype(np.float32)
    r_arr = np.concatenate(right).astype(np.float32)
    n = min(len(l_arr), len(r_arr))
    return l_arr[:n], r_arr[:n], ""


def channel_reason(left, right) -> str:
    """"" when this file really is one speaker per channel, else why it is not."""
    import numpy as np

    if len(left) < SAMPLE_RATE:
        return "shorter than a second"
    if np.array_equal(left, right):
        # The commonest way to get a "stereo" file with one speaker in it: a mono
        # recording duplicated into two identical tracks.
        return "the two channels are identical"

    corr = float(np.corrcoef(left, right)[0, 1])
    if not np.isfinite(corr):
        return "a channel is silent"
    if abs(corr) > MAX_CORRELATION:
        # Both speakers on both tracks — a mixed-down recording. The energies then
        # rise and fall together and say nothing about who is talking.
        return f"the channels are correlated ({corr:+.3f}), so they are mixed"

    # Per-second energy, over the seconds where somebody is speaking.
    width = SAMPLE_RATE
    count = max(len(left) - width, 1) // width
    e_left = np.array(
        [np.sqrt((left[i * width : i * width + width] ** 2).mean() + 1e-9) for i in range(count)]
    )
    e_right = np.array(
        [np.sqrt((right[i * width : i * width + width] ** 2).mean() + 1e-9) for i in range(count)]
    )
    speaking = (e_left > FRAME_FLOOR_ABS) | (e_right > FRAME_FLOOR_ABS)
    total = int(speaking.sum())
    if total < 10:
        return "almost nothing above the noise floor"

    l_dom = int(((e_left > DOMINANCE_RATIO * e_right) & speaking).sum())
    r_dom = int(((e_right > DOMINANCE_RATIO * e_left) & speaking).sum())
    comparable = total - l_dom - r_dom
    if comparable / total > MAX_COMPARABLE_SHARE:
        return f"{100 * comparable / total:.0f}% of speech is on both channels at once"
    if min(l_dom, r_dom) / total < MIN_MINORITY_SHARE:
        # One side carries nearly everything: either a single-sided recording, or
        # both people on one track with leakage on the other. Either way there is
        # no second speaker to find, and labelling would put the whole call on one.
        return "one channel carries nearly all the speech"
    return ""


def label_segments(segments, left, right):
    """A speaker for each segment: 'A' (left), 'B' (right), or None when unclear.

    Two separate ways to be unclear, and both of them end in None rather than in a
    guess: the two channels are comparable over the whole segment (nobody is
    clearly louder, which is what crosstalk and both-at-once sound like), or the
    segment STRADDLES a change of speaker, which the frame-by-frame count catches
    even when the totals look decisive.

    WHICH CHANNEL WINS is decided by the energy over the whole segment, which is
    the rule the trial proved against a manual read. The frames only ever VETO —
    they can turn a label into None, and they are never allowed to swap A for B.
    That division matters: on the trial call the two rules disagreed about the
    winner on 5 of 283 segments, and there is no evidence which of them was right,
    so the proven one keeps the decision and the new one keeps its doubt.
    """
    import numpy as np

    frame = max(1, int(FRAME_SECS * SAMPLE_RATE))
    out = []
    for seg in segments:
        start = max(0, int(seg["start"] * SAMPLE_RATE))
        end = min(len(left), int(seg["end"] * SAMPLE_RATE))
        if end - start < frame // 2:
            out.append(None)
            continue

        l_seg = left[start:end]
        r_seg = right[start:end]
        e_left = float(np.sqrt((l_seg**2).mean() + 1e-9))
        e_right = float(np.sqrt((r_seg**2).mean() + 1e-9))
        if e_left <= DOMINANCE_RATIO * e_right and e_right <= DOMINANCE_RATIO * e_left:
            out.append(None)  # comparable energy: it cannot tell, so it does not
            continue

        who = "A" if e_left > e_right else "B"

        # The frames, to catch a segment that spans a change of speaker.
        frames = (end - start) // frame
        if frames < 1:
            out.append(who)
            continue
        fl = np.array(
            [np.sqrt((l_seg[i * frame : (i + 1) * frame] ** 2).mean() + 1e-9) for i in range(frames)]
        )
        fr = np.array(
            [np.sqrt((r_seg[i * frame : (i + 1) * frame] ** 2).mean() + 1e-9) for i in range(frames)]
        )
        loudest = float(max(fl.max(), fr.max()))
        floor = max(FRAME_FLOOR_ABS, FRAME_FLOOR_SHARE * loudest)
        speaking = (fl > floor) | (fr > floor)
        l_dom = int(((fl > DOMINANCE_RATIO * fr) & speaking).sum())
        r_dom = int(((fr > DOMINANCE_RATIO * fl) & speaking).sum())
        decided = l_dom + r_dom
        if decided == 0:
            out.append(None)
            continue
        if min(l_dom, r_dom) / decided > STRADDLE_SHARE:
            out.append(None)  # both people are in this segment
            continue
        out.append(who)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe one audio file.")
    parser.add_argument("--file", required=True, help="path to the audio file")
    parser.add_argument("--model", required=True, help="faster-whisper model, e.g. small")
    parser.add_argument(
        "--language",
        default=None,
        help="force a language (e.g. en) instead of detecting it",
    )
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="int8 (default, fastest on CPU), int8_float32 or float32",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=1,
        # MEASURED, on one real 13m29s call with the `small` model: beam 1 took
        # 371s and beam 5 took 894s — two and a half times the work — for the same
        # word count and a read that was no better. Beam search pays off on
        # ambiguous audio; a two-party phone call in English is not that. This is a
        # setting rather than a constant only so the comparison can be repeated on
        # a worse recording; 1 is the answer until one of those turns up.
        help="decoder beam width (default 1: measured 2.4x faster than 5, same quality)",
    )
    parser.add_argument(
        "--cpu-threads",
        type=int,
        default=0,
        # 0 means "whatever the library decides", which is the right answer on the
        # live box: 3 cores shared with 26 other applications. The development
        # machine has 16 cores and nothing competing, and the backlog is
        # transcribed there, so the caller can say so.
        help="threads for the decoder (default 0: let the library decide)",
    )
    parser.add_argument(
        "--no-prompt",
        action="store_true",
        help="run without the short vocabulary prompt (for comparing one against the other)",
    )
    parser.add_argument(
        "--no-speakers",
        action="store_true",
        help="skip the speaker labels even on a dual-channel file",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        print(f"no such file: {args.file}", file=sys.stderr)
        return 2

    try:
        from faster_whisper import WhisperModel
    except ImportError as err:
        print(
            "faster-whisper is not installed in this interpreter "
            f"({sys.executable}): {err}",
            file=sys.stderr,
        )
        return 3

    # CPU only. The server has no GPU and the development machine's is not
    # something to depend on; int8 is several times quicker than float32 on a
    # CPU for output that reads the same.
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type=args.compute_type,
        cpu_threads=max(0, args.cpu_threads),
    )

    # vad_filter drops the silence between utterances, which is most of a hold
    # or a pause on a call: it cuts the work and stops the model inventing words
    # out of line noise.
    segments, info = model.transcribe(
        args.file,
        language=args.language,
        vad_filter=True,
        beam_size=max(1, args.beam_size),
        initial_prompt=None if args.no_prompt else INITIAL_PROMPT,
    )

    # `segments` is a generator: consuming it is what does the work.
    out = [
        {"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": s.text.strip()}
        for s in segments
    ]
    _log(f"{len(out)} segments decoded")

    # ---- the speaker labels, from the channels of the same file --------------
    speakers = {"labelled": False, "method": "channel-energy", "unknown": len(out), "reason": None}
    if args.no_speakers:
        speakers["reason"] = "asked not to"
    else:
        left, right, reason = load_channels(args.file)
        if left is None:
            speakers["reason"] = reason
        else:
            reason = channel_reason(left, right)
            if reason != "":
                # NOT an error, and not a failed transcription: the words are
                # right, there is simply nobody to attribute them to. The panel
                # shows the transcript without labels.
                speakers["reason"] = reason
            else:
                labels = label_segments(out, left, right)
                for seg, who in zip(out, labels):
                    if who is not None:
                        seg["speaker"] = who
                speakers["labelled"] = True
                speakers["unknown"] = sum(1 for who in labels if who is None)
                speakers["reason"] = None
        _log(
            f"speakers: {'labelled' if speakers['labelled'] else 'not labelled'}"
            f" ({speakers['unknown']} unclear of {len(out)})"
            + (f" — {speakers['reason']}" if speakers["reason"] else "")
        )

    json.dump(
        {
            "segments": out,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
            "model": args.model,
            "speakers": speakers,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
