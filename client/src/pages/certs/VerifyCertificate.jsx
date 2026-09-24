import { Link, useParams } from 'react-router-dom';
import { TRACKS } from '@fac-academy/shared';
import { useVerification } from '../../api/certs.js';
import { cardClass, heroGradient } from '../../components/training/styles.js';

/*
 * The public certificate check (S09, task 3).
 *
 * No sign-in: anyone holding a certificate — a recruiter, a client, a new
 * employer — can open the address printed on it and see whether it is real.
 * The server answers with five facts and nothing else, so there is nothing on
 * this page about the person beyond what is printed on the certificate itself.
 *
 * "Not valid" is a normal answer, not an error: an id that never existed, a
 * changed id and a withdrawn certificate all look the same here, on purpose.
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

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-bg">
      <header style={heroGradient} className="px-6 py-7 text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded bg-orange" />
          <span className="font-display text-lg font-extrabold">FAC Academy</span>
          <span className="ml-auto text-[12px] tracking-[0.12em] text-white/60 uppercase">
            Certificate check
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
    </div>
  );
}

function Fact({ label, children, mono = false }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className={`mt-1 text-[15px] text-ink ${mono ? 'font-mono break-all text-[13px]' : ''}`}>
        {children}
      </dd>
    </div>
  );
}

export default function VerifyCertificate() {
  const { publicId = '' } = useParams();
  const { data, isPending, isError, refetch } = useVerification(publicId);

  if (isPending) {
    return (
      <Frame>
        <p className={`${cardClass} p-6 text-muted`}>Checking this certificate…</p>
      </Frame>
    );
  }

  if (isError) {
    return (
      <Frame>
        <div className={`${cardClass} p-6`}>
          <h1 className="font-display text-lg font-bold text-navy">
            We couldn&apos;t check this certificate.
          </h1>
          <p className="mt-2 text-muted">
            Please try again in a moment. If it keeps happening, contact Fast Action Claims.
          </p>
          <button
            type="button"
            className="mt-4 rounded-[10px] border-[1.5px] border-line px-5 py-2.5 text-[14px] font-bold text-navy hover:border-navy"
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      </Frame>
    );
  }

  if (!data.valid) {
    return (
      <Frame>
        <section className={`${cardClass} border-l-4 border-l-red p-6 sm:p-8`}>
          <h1 className="font-display text-xl font-bold text-navy">
            This certificate could not be verified.
          </h1>
          <p className="mt-3 text-[14.5px] text-muted">
            We have no valid certificate with that id. Check that the id was typed exactly as it is
            printed — it is case-sensitive. A certificate that has been withdrawn also shows here as
            not verified.
          </p>
          <p className="mt-4 font-mono text-[13px] break-all text-muted">Id checked: {publicId}</p>
        </section>
      </Frame>
    );
  }

  return (
    <Frame>
      <section className={`${cardClass} border-l-4 border-l-green p-6 sm:p-8`}>
        <p className="text-[12px] font-semibold tracking-[0.18em] text-green uppercase">
          Verified certificate
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold text-navy">{data.name}</h1>
        <p className="mt-2 text-[15px] text-muted">
          completed <span className="font-semibold text-ink">{data.completed}</span> with Fast
          Action Claims.
        </p>

        <dl className="mt-6 grid gap-5 border-t border-line pt-5 sm:grid-cols-3">
          <Fact label="Programme">{trackLabel(data.track)}</Fact>
          <Fact label="Issued">{formatDate(data.issuedAt)}</Fact>
          <Fact label="Certificate id" mono>
            {publicId}
          </Fact>
        </dl>
      </section>
      <p className="mt-6 text-[13px] text-muted">
        Staff can see their own certificates in the{' '}
        <Link className="font-semibold text-navy underline" to="/certificates">
          academy
        </Link>
        .
      </p>
    </Frame>
  );
}
