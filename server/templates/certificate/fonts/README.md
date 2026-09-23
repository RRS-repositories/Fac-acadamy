# Certificate fonts

Two font files, embedded in the certificate PDF as base64 data URIs by
`server/src/certs/render.ts`.

| File | Family | Subset |
|---|---|---|
| `inter-latin.woff2` | Inter (variable, 100–900) | latin |
| `outfit-latin.woff2` | Outfit (variable, 100–900) | latin |

They are the same two faces the browser app loads from Google Fonts
(`client/index.html`), so a certificate looks like the app it came from.

**Why they are committed rather than fetched.** A certificate is rendered on
the server, which may have no route out to `fonts.gstatic.com` — and a PDF that
silently falls back to a different typeface on a bad network day is worse than
one that never renders. Embedding the latin subsets (62 KB in total) means the
PDF is byte-for-byte the same on a laptop, in CI and on the on-prem server, with
no network call at render time.

Both families are licensed under the SIL Open Font License 1.1, which permits
embedding in documents. Upstream: <https://fonts.google.com/specimen/Inter> and
<https://fonts.google.com/specimen/Outfit>.

To refresh them, request the `latin` subset of each family from the Google
Fonts CSS API with a modern browser user-agent and save the `woff2` each
`/* latin */` block points at under these names. Nothing else needs changing:
`render.ts` reads whatever is here.
