// A plain full-page message used while sign-in is being checked or when the
// portal can't be reached. No user data is shown here.
export default function AuthStatusScreen({ title, message, action, busy = false }) {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16" aria-busy={busy || undefined}>
      <h1 className="text-2xl font-bold" role={busy ? 'status' : undefined}>
        {title}
      </h1>
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
