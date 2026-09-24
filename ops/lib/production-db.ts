// The one place that decides whether a database name is production.
//
// WHY THIS FILE EXISTS
// --------------------
// Every ops script carries a wrong-database guard: --expect-db must equal
// current_database(), and the scripts that are development-only refuse a name
// that "looks like production". That test used to be a substring search for
// 'prod' or 'live', which is fine against academy_prod or crm_live — and
// useless here.
//
// The academy shares the CRM's Postgres, and that database is called
//
//     client_credentials
//
// which contains neither hint. The guard therefore stayed silent on the only
// database it actually needed to catch: 13 GB of live client data, 416 tables,
// the entire company. The single thing standing between a mistyped --expect-db
// and the live CRM was the person at the keyboard.
//
// So the name is listed here explicitly, beside the hints.
//
// TWO DIFFERENT ANSWERS, ON PURPOSE
// ---------------------------------
// "Is this production?" is one question; what to do about it is two:
//
//   * ops/media/* and ops/backup/*  — development and staging tools. They seed,
//     extract, restore and drop. They must REFUSE production outright: there is
//     no legitimate reason to run them against it, and the restore drill drops
//     a schema.
//
//   * ops/admin/*  — reset an authenticator, set a track, authorise stage 1.
//     These ARE production tools; that is the whole point of them (D14: IT
//     resets authenticators with an audited command). They must not refuse, but
//     they must not let it happen by accident either, so they require
//     --confirm-production in addition to --expect-db. Two flags naming the
//     same live database is hard to type by mistake.

/**
 * Databases we know by name to be production. `client_credentials` is the CRM's
 * own database, which the academy shares with its own `academy` schema.
 *
 * Add to this list; never remove from it to make a command run.
 */
export const KNOWN_PRODUCTION_DB_NAMES: readonly string[] = Object.freeze(['client_credentials']);

/** Substrings that give a production database away by convention. */
const PRODUCTION_HINTS: readonly string[] = Object.freeze(['prod', 'live']);

/**
 * True when a database name is production, by name or by convention.
 *
 * It is deliberately generous: a false positive costs a `--confirm-production`
 * flag or a rename, a false negative costs the company's database.
 */
export function isProductionDbName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === '') return false;
  // Substring, not equality, and for the same reason the hints are substrings:
  // `client_credentials_drill` is a throw-away name by convention, but a
  // database sitting next to the live one under nearly the live one's name is
  // one careless tab-completion away from the real thing. Nobody needs it.
  return [...KNOWN_PRODUCTION_DB_NAMES, ...PRODUCTION_HINTS].some((hint) => lower.includes(hint));
}

/** The reason a name was rejected, for an error message that teaches. */
export function productionReason(name: string): string {
  const lower = name.trim().toLowerCase();
  return KNOWN_PRODUCTION_DB_NAMES.some((known) => lower.includes(known))
    ? `"${name}" is (or is named after) the live CRM database`
    : `the name "${name}" looks like production`;
}
