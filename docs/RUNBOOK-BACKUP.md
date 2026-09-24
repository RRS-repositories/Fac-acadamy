# Runbook — backing up the Academy, and proving the backup works

*For Brad and whoever looks after the server. No commands you need to memorise: the two
scripts below do the work, and everything they need is a setting on the server, not
something written down in here.*

---

## 1. Why there are two halves

The Academy keeps its information in two places, and a backup is only a backup if it has
both:

| Half | What is in it | What is lost without it |
|---|---|---|
| **The database** | Everyone's account, track and progress; every lesson, question, answer and pass mark; the certificate records; the audit trail | Who has done what. Everything. |
| **The media folder** | The call recordings, the walkthrough video, and the certificate PDFs — ordinary files on the server's own disk | Every recording and every certificate. The training pages would load with silent players and broken certificate links. |

This is the one thing to remember: **a backup that only dumps the database is not a
backup.** There is no cloud storage bucket behind the Academy (decision D15) — the
recordings and the certificates are files on the server, so the backup has to copy them
too.

---

## 2. What runs, and how often

**Nightly, when nobody is using the site.** One scheduled job runs the backup script. It
takes a few seconds for the database and as long as it takes to copy the media folder
(about 35 MB today, so seconds).

Suggested pattern, to be confirmed with IT:

- every night: one full backup;
- keep 14 nightly copies, 8 weekly copies and 6 monthly copies;
- the backup folder is on a different disk from the Academy, and is itself included in
  whatever off-site backup the firm already runs;
- **once a quarter, and before go-live, run the restore drill** (section 5) and keep the
  printed result.

The database is the same one the CRM uses, so the CRM's own backup already covers the
Academy's tables. The Academy backup exists so that the Academy can be restored **on its
own**, and so that the media folder is covered at all — the CRM's backup knows nothing
about it.

---

## 3. Where it writes

The script is given an output folder — a setting, not something fixed in the code. It
must be **outside the Academy's code folder**; the script refuses to write anywhere
inside it, because a dump and 35 MB of real client recordings must never end up in the
source code repository.

Each run makes its own dated folder, so nothing is ever overwritten:

```
<backup folder>/
  academy-backup-20260923-141408/
    database/academy.dump     the database, in PostgreSQL's own compressed format
    media/...                 a copy of the media folder, laid out exactly as it is live
    manifest.json             the receipt: what is in the other two
```

The **manifest** is the part that makes the drill possible. It records the date and time,
which database the backup came from, the schema version (the last database change that
had been applied), how many rows every table held, a fingerprint of the training content,
and — for every media file — its size and its checksum. It holds no passwords and no
lesson text: names, counts and checksums only, so it is safe to read and to send on.

---

## 4. Taking a backup

```
npx tsx ops/backup/backup.ts --out <the backup folder> --expect-db <the database name>
```

It prints what it wrote: the size of the dump, the number of tables and rows, the schema
version, the number of media files and their total size, and the four paths.

Things worth knowing:

- it only **reads** the database, so it is safe to run at any time;
- the database half is taken from a single point in time, and the row counts in the
  manifest describe exactly the rows inside the dump — they cannot drift apart;
- the media copy happens straight afterwards, which is why the job is scheduled for a
  quiet hour: a recording uploaded in the seconds between the two halves would be in one
  and not the other;
- every copied file is checksummed twice, once from the original and once from the copy.
  If those two ever disagree the backup stops rather than pretending to have succeeded;
- passwords are passed to PostgreSQL privately. They never appear on screen, in a log, or
  in the list of running commands.

---

## 5. Proving it works — the restore drill

A backup nobody has ever restored is a guess. The drill restores the newest backup into a
**throw-away copy** — a scratch database and a scratch folder, never the live ones — and
then checks it.

```
npx tsx ops/backup/restore-drill.ts --from <the backup folder>
```

It prints a PASS/FAIL table and stops with an error code if anything failed, so a
scheduled run will raise an alarm rather than pass quietly. When it has finished it
**deletes the throw-away copies** (add `--keep` if you want to poke around in them).

### What "verified" means

The drill does not take the restore on trust. It checks all of this:

1. **The backup is the one that was written** — the dump file still has the exact size and
   checksum the manifest recorded, so a half-copied or corrupted file is caught here.
2. **The restore itself ran clean** — PostgreSQL reported no errors putting it back.
3. **Every media file came back** — same number of files, and each one's checksum matches
   the original byte for byte. Nothing missing, nothing changed, nothing extra.
4. **Every table is there**, with the same names as in the backup.
5. **Every table has the same number of rows** as the backup. Not "about the same": the
   same.
6. **The training content is identical** — a single fingerprint is computed over every
   lesson, question, answer, pass mark, status-guide line and track rule, and it must
   match the one taken at backup time. This is the same fingerprint the content
   verification tool prints, so the two can be compared by eye.
7. **The schema version matches** — the restored copy is at the same database version.
8. **The two halves still agree** — every recording and certificate the restored database
   points at really exists in the restored media folder. This is the check that would
   catch a database-only backup.
9. **Certificates still open** — every restored certificate PDF begins with the marker
   that makes it a PDF, so it is a real document and not an empty or truncated file.

Any one of those failing makes the whole drill fail, and the table says which and why.

### If the drill cannot create its throw-away database

The login used for the restore has to be allowed to create a database. If it is not, the
drill stops and says so in one line. Either give it that permission once, or create the
scratch database by hand and re-run with `--into-existing --drop-schema`, which reuses it
instead. It will refuse any database whose name does not clearly mark it as disposable,
and it will never touch the live database or the one the backup came from.

---

## 6. Restoring for real

The drill is a rehearsal. A real restore is the same two halves, done deliberately and
with the Academy switched off:

1. **Stop the Academy** (turn the `ACADEMY_V2` flag off and stop the application), so
   nobody writes to a half-restored system.
2. **Restore the database** from `database/academy.dump` with PostgreSQL's restore tool,
   into the database named in the settings. The `citext` extension has to exist first —
   the drill does this automatically, and the database administrator does it once by hand
   for a real restore.
3. **Restore the media** by copying the backup's `media` folder back over the live media
   folder, keeping the same layout.
4. **Run the drill's checks against the real thing** — or, more simply, sign in and open a
   stage that has recordings, play one, and download a certificate.
5. **Start the Academy again** and turn the flag back on.

Never restore the database without the media, or the other way round. The database points
at files by name; the files mean nothing without the database.

---

## 7. The settings the scripts use

All of these are environment settings on the server. None of them is written down in the
code, and none of them belongs in this document.

| Setting | What it is for |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME` | which database server and database |
| `BACKUP_DB_USER`, `BACKUP_DB_PASSWORD` | the login used to read for a backup and to restore. Falls back to the migration login, then the application login |
| `MEDIA_ROOT` | the folder that holds the recordings, the video and the certificate PDFs |
| `PG_BIN` | where PostgreSQL's own tools live, if they are not already on the system path |
| `BACKUP_MAINTENANCE_DB` | the database the drill connects to in order to create and drop its scratch copy (normally the server's default) |

---

## 8. When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Refusing to write the backup inside the repo" | The output folder points into the Academy's code folder | Point it at the backup volume |
| "MEDIA_ROOT is not set" | The script was not told where the media lives, and would have backed up half the system | Set it, then re-run |
| "The copy of … does not match the original" | A file changed or the disk misread it while copying | Re-run. If it happens twice, the disk needs looking at |
| "may not create databases" | The restore login is not allowed to make the scratch copy | See the note at the end of section 5 |
| The drill's table shows a FAIL | The restored copy is not the same as what was backed up | Do not rely on that backup. The row that failed says what differed; take a fresh backup and run the drill again before anything else |
| "No backup found under …" | Nothing has been written there yet, or the folder is wrong | Check the scheduled job ran |

---

## 9. Keep the evidence

The go-live checklist asks for a restore drill to have been performed, with evidence.
Save the drill's printed output — the PASS/FAIL table, with the date, the database name,
the schema version and the file counts — alongside the sign-off. It is a page of plain
text, and it is the only proof that the backups are real.
