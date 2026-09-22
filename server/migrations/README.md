# Migrations (arrive in S01)

- `0000_extensions` — `CREATE EXTENSION IF NOT EXISTS citext`.
- `0001_academy_schema` — the supplied `fac-academy-schema.sql`, verbatim. Never edited in place.
- `0002_academy_v2_alignment` onwards — fixes forward on top of 0001.
- We write migrations; **Brad applies them in production**. Nobody else runs them against production.
