// A plain full-page screen used while sign-in is being checked or when the
// portal can't be reached. No user data is shown here.
//
// The busy case is deliberately different from the others. It is the first
// thing anyone sees on every visit, before we know who they are, and it is
// usually on screen for a fraction of a second. A heading reading "Loading…"
// in the top-left corner reads as a page that has failed to render. A spinner
// in the middle of the screen reads as a page that is on its way.
export default function AuthStatusScreen({ title, message, action, busy = false }) {
  if (busy) {
    return (
      <main
        className="flex min-h-screen items-center justify-center px-6"
        aria-busy="true"
        data-testid="full-page-loading"
      >
        <div role="status" className="flex flex-col items-center gap-4">
          {/*
           * A ring with one coloured quarter, spun. Hidden outright when the
           * viewer has asked for reduced motion — a ring that does not turn
           * looks like a broken image — and the wording below becomes visible
           * instead, so that case still says what is happening.
           */}
          <span
            aria-hidden="true"
            className="size-10 animate-spin rounded-full border-[3px] border-line border-t-orange motion-reduce:hidden"
          />
          <span className="sr-only text-sm text-muted motion-reduce:not-sr-only">{title}</span>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-2xl font-bold">{title}</h1>
      {message && <p className="mt-2 text-muted">{message}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-5 rounded-[10px] bg-orange px-5 py-2.5 text-sm font-bold text-white hover:bg-[#d8632c]"
        >
          {action.label}
        </button>
      )}
    </main>
  );
}
