/*
 * Online now = the server saw this trainee in the last three minutes. The dot
 * is decoration; the words next to it are what a screen reader announces, so
 * the state never depends on colour alone.
 *
 * Offline, the words are hidden by default (the roster used to have a column
 * of "Offline" saying nothing). Pass showLabel when the caller has something
 * worth reading there — the roster's Status column shows the last-seen day and
 * time instead.
 */
export default function OnlineDot({ online, label = null, showLabel = false }) {
  const text = label ?? (online ? 'Online now' : 'Offline');
  let textClass = 'sr-only';
  if (online) textClass = 'text-[12.5px] font-semibold text-green';
  else if (showLabel) textClass = 'text-[12.5px] text-muted';

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        data-testid="online-dot"
        data-online={online ? 'true' : 'false'}
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
          online ? 'bg-green shadow-[0_0_0_3px_rgba(46,125,50,0.18)]' : 'bg-[#C7D0DA]'
        }`}
      />
      <span className={textClass}>{text}</span>
    </span>
  );
}
