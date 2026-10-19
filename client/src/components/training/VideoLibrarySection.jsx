import { libraryVideoStreamPath } from '../../api/videos.js';
import { formatClock } from './duration.js';
import { cardClass } from './styles.js';

/*
 * "Training Videos" — the shelf of videos that belong to no stage, under the
 * trainee's department training at the bottom of the dashboard.
 *
 * WHY THIS IS NOT A NoSeekPlayer, AND MUST NOT BECOME ONE
 *
 * NoSeekPlayer exists for one job: to stop somebody skipping a recording they
 * have to hear in full, because a full listen is what unlocks that stage's
 * quiz. It hides the browser's controls, snaps a forward jump back, pins the
 * playback rate to 1 and beacons what was played to the server every five
 * seconds.
 *
 * None of that applies here. A library video belongs to no stage, so there is
 * no quiz behind it, no listening requirement to satisfy and no credit to
 * earn — watching one can never move a trainee's progress, by design (see
 * LibraryVideoSchema in shared/contracts/media.ts). A no-seek player would
 * therefore impose the cost of the rule with none of its purpose: somebody
 * looking up the one minute of a reference video they actually need would have
 * to sit through the rest of it for nothing.
 *
 * So each row is a plain <video> with the browser's own controls and free
 * seeking. There are no beacons on this path at all, and nothing on this
 * section posts anything.
 *
 * The section renders NOTHING when the list is empty — not even its heading.
 * The library is optional and most tracks will have none, and an empty
 * "Training Videos" heading under somebody's training reads as a fault.
 */

/** One row: the video, what it is, how long it is, and the player. */
function LibraryVideoRow({ video }) {
  const titleId = `library-video-${String(video.id)}-title`;

  return (
    <li
      data-video={video.id}
      className={`${cardClass} flex flex-col gap-1 px-[22px] py-[18px]`}
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-[14.5px] font-bold text-navy">
          {video.title}
        </h3>
        {/* Only when the server knows it: a length the file could not be read
            for is left out rather than shown as a guess or a dash. */}
        {video.durationSecs === null ? null : (
          <span className="text-[12.5px] text-muted tabular-nums">
            Length {formatClock(video.durationSecs)}
          </span>
        )}
      </div>

      {video.description === null ? null : (
        <p className="max-w-[70ch] text-[12.5px] text-muted">{video.description}</p>
      )}

      {/*
        `controls` on purpose — see the note at the top of this file. The
        element carries its own accessible name, because a <video> labelled only
        by the heading beside it is announced as "video" by most screen readers,
        and a page with six of those is unusable. Native controls are keyboard
        reachable, so there is no tabIndex to add.

        `controlsList="nodownload"` is tidiness, not a guard: it keeps the save
        option out of the overflow menu. Anybody who can play the video can
        fetch the same bytes, and the real control is that the route needs a
        session.
      */}
      <video
        src={libraryVideoStreamPath(video.id)}
        aria-label={`Training video: ${video.title}`}
        controls
        controlsList="nodownload"
        preload="metadata"
        playsInline
        data-testid={`library-video-${String(video.id)}`}
        className="mt-2 w-full rounded-[10px] bg-black"
      />
    </li>
  );
}

export default function VideoLibrarySection({ videos }) {
  if (!Array.isArray(videos) || videos.length === 0) return null;

  return (
    <section aria-labelledby="video-library" data-section="videos" className="mt-8">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-3.5">
        <h2 id="video-library" className="text-[19px] font-semibold">
          <span aria-hidden="true">🎬 </span>
          Training Videos
        </h2>
        <span className="text-[12.5px] font-semibold text-muted">
          {videos.length} video{videos.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mb-3 max-w-[70ch] text-[13.5px] text-muted">
        Watch these whenever you need them. They are not part of a stage, so nothing here is locked
        and nothing here is marked — skip to the part you want.
      </p>
      <ul className="grid gap-4 md:grid-cols-2">
        {videos.map((video) => (
          <LibraryVideoRow key={video.id} video={video} />
        ))}
      </ul>
    </section>
  );
}
