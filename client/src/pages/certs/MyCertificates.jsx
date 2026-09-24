import { Link } from 'react-router-dom';
import { TRACKS, certVerifyPath } from '@fac-academy/shared';
import { downloadUrl, useMyCertificates } from '../../api/certs.js';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import { btnGhost, btnPrimary, cardClass } from '../../components/training/styles.js';

/*
 * "My certificates" (S09): everything this trainee has earned, with a download
 * link for each and the id anyone can check.
 *
 * Every word on a card — what they completed, the accomplishment line — comes
 * from the server. The only text written here is the page's own furniture.
 */

function formatDate(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at);
}

function trackLabel(code) {
  return TRACKS.find((t) => t.code === code)?.label ?? code;
}

function Certificate({ certificate }) {
  return (
    <li className={`${cardClass} p-5 sm:p-6`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-[17px] font-bold text-navy">{certificate.title}</h3>
          {certificate.accomplishment ? (
            <p className="mt-1.5 inline-block rounded-full bg-orange-soft px-3 py-1 text-[12.5px] font-semibold text-orange">
              {certificate.accomplishment}
            </p>
          ) : null}
          <p className="mt-2 text-[13px] text-muted">
            {trackLabel(certificate.track)} · Issued {formatDate(certificate.issuedAt)}
          </p>
          <p className="mt-1 font-mono text-[12px] break-all text-muted">
            Certificate id: {certificate.publicId}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2">
          {certificate.downloadable ? (
            <a
              className={btnPrimary}
              href={downloadUrl(certificate.publicId)}
              // A plain link, not fetch: the browser saves the file the API
              // sends with Content-Disposition: attachment.
              download
            >
              Download PDF
            </a>
          ) : (
            <span className="rounded-[10px] bg-red-soft px-4 py-2.5 text-center text-[13px] font-semibold text-red">
              Withdrawn
            </span>
          )}
          <Link className={`${btnGhost} text-[13px]`} to={certVerifyPath(certificate.publicId)}>
            Check it
          </Link>
        </div>
      </div>
    </li>
  );
}

export default function MyCertificates() {
  const { data, isPending, isError, refetch } = useMyCertificates();

  return (
    <TrainingLayout>
      <header className="mb-5">
        <h1 className="font-display text-xl font-bold text-navy">My certificates</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          Every level and academy you have finished. Anyone you send a certificate to can check that
          it is genuine using the id printed on it.
        </p>
      </header>

      {isPending ? (
        <p className={`${cardClass} p-6 text-muted`}>Loading your certificates…</p>
      ) : isError ? (
        <div className={`${cardClass} p-6`}>
          <p className="text-muted">We couldn&apos;t load your certificates.</p>
          <button type="button" className={`${btnGhost} mt-4`} onClick={() => refetch()}>
            Try again
          </button>
        </div>
      ) : data.certificates.length === 0 ? (
        <p className={`${cardClass} p-6 text-muted`}>
          You don&apos;t have any certificates yet. Finish a level and one appears here
          automatically.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.certificates.map((certificate) => (
            <Certificate key={certificate.publicId} certificate={certificate} />
          ))}
        </ul>
      )}
    </TrainingLayout>
  );
}
