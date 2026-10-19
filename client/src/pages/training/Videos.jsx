import { useVideoLibrary } from '../../api/videos.js';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import VideoLibrarySection from '../../components/training/VideoLibrarySection.jsx';
import { cardClass } from '../../components/training/styles.js';

/*
 * The Training Videos page.
 *
 * The shelf is reachable from the journey rail on every screen, not only from
 * the bottom of the dashboard, because that is what it is for: somebody part
 * way through a stage who wants to re-watch how a DSAR review is done should
 * not have to go back to the dashboard to find it.
 *
 * It needs a sign-in but NOT a track (App.jsx), the same as the status guide:
 * the shelf belongs to no stage, so it belongs to no track either, and a new
 * starter waiting for a manager to assign them one can still watch it.
 */
export default function Videos() {
  const videos = useVideoLibrary();
  const list = videos.data?.videos ?? [];

  if (videos.isPending) {
    return (
      <TrainingLayout>
        <section className={`${cardClass} p-6`}>
          <h1 className="text-lg font-semibold">Loading the videos…</h1>
        </section>
      </TrainingLayout>
    );
  }

  // Empty is a normal state, not a fault: the shelf is optional and starts
  // bare. Say so plainly rather than showing a heading over nothing.
  if (list.length === 0) {
    return (
      <TrainingLayout>
        <section className={`${cardClass} px-8 py-14 text-center`}>
          <h1 className="text-[19px] font-semibold">No training videos yet</h1>
          <p className="mx-auto mt-2 max-w-[420px] text-sm text-muted">
            When videos are added they will appear here, and in your journey on the left.
          </p>
        </section>
      </TrainingLayout>
    );
  }

  return (
    <TrainingLayout>
      <VideoLibrarySection videos={list} heading="h1" />
    </TrainingLayout>
  );
}
