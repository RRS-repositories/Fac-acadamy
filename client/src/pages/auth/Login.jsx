import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import BrandPanel from '../../components/auth/BrandPanel.jsx';
import { NO_MANAGER_ACCESS } from '../../components/auth/ManagerAccessNotice.jsx';
import SignInTabs, {
  MANAGER_TAB,
  readRememberedTab,
  rememberTab,
  STAFF_TAB,
  tabButtonId,
} from '../../components/auth/SignInTabs.jsx';
import { ApiError, login, verifyMfa } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { safeNext } from '../../auth/safeNext.js';

// Sign-in screen. Production flow (D11, approve first): the starter's CRM
// account already exists, so they sign in with CRM email + password, then an
// authenticator code. First sign-in sets the authenticator up.
//
// The prototype's two tabs are back, but only as a statement of intent: they
// change the card's wording and where the user lands afterwards. The role
// comes from the CRM account, the server decides it, and there is no passcode
// field. The request body and the authenticator step are the same either way.
// API: POST /api/auth/login, then POST /api/auth/mfa (shared/contracts/auth).

// Copy per tab. The staff heading is the prototype's; the staff subtitle is
// ours, because under D11 IT creates the CRM account before day one — the
// prototype's "details your manager gave you" describes the old flow.
const TAB_COPY = {
  [STAFF_TAB]: {
    heading: 'Sign in to start training',
    subtitle: 'Use your CRM email and password. IT sets your account up before your first day.',
    note: 'Managers use this same sign-in. The management area opens automatically for manager accounts.',
  },
  [MANAGER_TAB]: {
    heading: 'Manager sign in',
    subtitle: 'Management access: live trainee view, scores, authorisation and account control.',
    note: 'Same email and password as always. Management access comes from your CRM account, not from this choice.',
  },
};

const ERROR_TEXT = {
  invalid_credentials:
    "That email and password don't match a CRM account. Check them and try again.",
  locked:
    'Too many failed attempts, so sign-in is paused for this account. Try again later, or ask IT to unlock it.',
  disabled: 'This account has been disabled. Please speak to your manager.',
  invalid_code:
    "That code didn't work. Codes change every 30 seconds, so enter the newest one from your app.",
  rate_limited: 'Too many attempts from this device. Wait a minute and try again.',
  auth_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  mfa_required: 'Your sign-in took too long. Please start again.',
  not_approved: "Your CRM account isn't approved yet. Ask IT.",
  flag_off: "The training portal isn't open yet.",
};

// The pending sign-in step has gone on the server: back to step 1.
const RESTART_CODES = new Set(['mfa_required', 'not_signed_in']);

function errorCode(error) {
  return error instanceof ApiError ? error.code : 'unknown';
}

const inputClass =
  'w-full rounded-[10px] border-[1.5px] border-line bg-white px-4 py-3 text-[15px] text-ink placeholder:text-muted/70 focus:border-orange focus:outline-none aria-[invalid=true]:border-red';
const labelClass = 'mb-1.5 block text-[12.5px] font-bold tracking-[0.04em] text-navy uppercase';
const primaryButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-orange px-5 py-3 text-[15px] font-bold text-white transition-[background-color,box-shadow] hover:bg-[#d8632c] hover:shadow-[0_6px_16px_rgba(232,113,58,0.35)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none';
const linkButtonClass =
  'text-sm font-semibold text-navy underline decoration-line underline-offset-4 hover:decoration-navy';

export default function Login() {
  const { me, status, setMe } = useAuth();
  const [searchParams] = useSearchParams();
  const rawNext = searchParams.get('next');
  const next = safeNext(rawNext);
  // A ?next= the user was actually sent here with wins over the tab choice.
  // One that safeNext rejected (off-site, or back to /login) does not count.
  const nextIsExplicit = typeof rawNext === 'string' && rawNext.length > 0 && next === rawNext;

  const [tab, setTab] = useState(readRememberedTab);
  const [landing, setLanding] = useState(null);
  const [step, setStep] = useState('credentials'); // credentials | challenge | enrol
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [enrol, setEnrol] = useState(null);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null);
  const panelId = useId();
  const copy = TAB_COPY[tab];

  // Move focus to the new heading when the step changes, so screen readers
  // announce it (the page itself doesn't navigate).
  useEffect(() => {
    if (step !== 'credentials') headingRef.current?.focus();
  }, [step]);

  function chooseTab(nextTab) {
    setTab(nextTab);
    rememberTab(nextTab);
    // Whatever is already typed stays typed: only the wording changes.
  }

  // Where a successful sign-in lands. The tab is intent only — a staff account
  // that chose Manager still goes to its training, with one calm line saying
  // this account has no management access.
  function landingFor(user) {
    if (nextIsExplicit) return { to: next, noManagerAccess: false };
    if (tab === MANAGER_TAB) {
      if (user.role === 'MANAGER') return { to: '/manager', noManagerAccess: false };
      return { to: '/', noManagerAccess: true };
    }
    return { to: '/', noManagerAccess: false };
  }

  async function submitCredentials(event) {
    event.preventDefault();
    const errors = {};
    if (!email.trim()) errors.email = 'Enter your work email.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errors.email = 'Enter an email address like name@company.co.uk.';
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length) return;

    setBusy(true);
    let result;
    try {
      result = await login(email.trim(), password);
    } catch (err) {
      setError(errorCode(err));
      setPassword('');
      return;
    } finally {
      setBusy(false);
    }
    setCode('');
    setEnrol(result.next === 'enrol' ? result.enrol : null);
    setStep(result.next);
  }

  async function submitCode(event) {
    event.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: 'Enter the 6 digits from your authenticator app.' });
      return;
    }
    setFieldErrors({});
    setBusy(true);
    let signedInUser;
    try {
      signedInUser = await verifyMfa(code);
    } catch (err) {
      const failure = errorCode(err);
      if (RESTART_CODES.has(failure)) {
        startOver();
        setError('mfa_required');
      } else {
        setError(failure);
        setCode('');
      }
      return;
    } finally {
      setBusy(false);
    }
    // Signed in: the redirect below takes them where they belong.
    setLanding(landingFor(signedInUser));
    setMe(signedInUser);
  }

  function startOver() {
    setStep('credentials');
    setPassword('');
    setCode('');
    setEnrol(null);
    setError(null);
    setFieldErrors({});
  }

  // Already signed in (or just finished signing in): go where they were headed.
  if (me) {
    return (
      <Navigate
        to={landing?.to ?? next}
        replace
        state={landing?.noManagerAccess ? { managerAccess: NO_MANAGER_ACCESS } : null}
      />
    );
  }
  // Still checking for an existing session: avoid flashing the form.
  if (status === 'loading') return null;

  return (
    <div className="flex min-h-screen flex-col bg-bg lg:flex-row">
      <BrandPanel />

      <main className="flex flex-1 items-center justify-center px-5 py-10 sm:p-10">
        <div className="w-full max-w-[420px]">
          {step === 'credentials' && (
            <>
              <SignInTabs value={tab} onChange={chooseTab} panelId={panelId} />
              <form
                id={panelId}
                role="tabpanel"
                aria-labelledby={tabButtonId(tab)}
                onSubmit={submitCredentials}
                noValidate
              >
                <div aria-live="polite">
                  <h2 className="mb-1.5 text-[26px] font-bold">{copy.heading}</h2>
                  <p className="mb-6 text-sm text-muted">{copy.subtitle}</p>
                </div>

                <ErrorAlert error={error} />

                <Field
                  label="Work email"
                  error={fieldErrors.email}
                  input={(props) => (
                    <input
                      {...props}
                      type="email"
                      autoComplete="username"
                      placeholder="you@rowanrose.co.uk"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  )}
                />

                <Field
                  label="Password"
                  error={fieldErrors.password}
                  input={(props) => (
                    <div className="relative">
                      <input
                        {...props}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        className={`${props.className} pr-16`}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-pressed={showPassword}
                        className="absolute inset-y-0 right-0 px-4 text-[13px] font-semibold text-navy"
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  )}
                />

                <button type="submit" className={`${primaryButtonClass} mt-2`} disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>

                <p className="mt-4 text-center text-sm text-muted">
                  Forgotten your password? Reset it in the CRM, or ask IT.
                </p>

                <Note>{copy.note}</Note>
              </form>
            </>
          )}

          {step === 'challenge' && (
            <form onSubmit={submitCode} noValidate>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="mb-1.5 text-[26px] font-bold focus:outline-none"
              >
                Enter your authenticator code
              </h2>
              <p className="mb-6 text-sm text-muted">
                Open the authenticator app on your phone and enter the 6-digit code shown for FAC
                Academy. Signing in as <b className="text-ink">{email.trim()}</b>.
              </p>

              <ErrorAlert error={error} />
              <CodeField value={code} onChange={setCode} error={fieldErrors.code} />

              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Checking…' : 'Verify and sign in'}
              </button>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <button type="button" onClick={startOver} className={linkButtonClass}>
                  Use a different account
                </button>
                <span className="text-sm text-muted">Lost your phone? Ask IT to reset it.</span>
              </div>
            </form>
          )}

          {step === 'enrol' && enrol && (
            <form onSubmit={submitCode} noValidate>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="mb-1.5 text-[26px] font-bold focus:outline-none"
              >
                Set up your authenticator
              </h2>
              <p className="mb-5 text-sm text-muted">
                You only do this once. After today you&apos;ll enter a code from your phone each
                time you sign in.
              </p>

              <ErrorAlert error={error} />

              <ol className="mb-5 space-y-4 text-sm">
                <EnrolStep n={1}>
                  Install an authenticator app on your phone, such as Microsoft Authenticator or
                  Google Authenticator.
                </EnrolStep>
                <EnrolStep n={2}>
                  <span>Scan this QR code with the app.</span>
                  <img
                    src={enrol.qrDataUrl}
                    alt="QR code to add FAC Academy to your authenticator app"
                    width={160}
                    height={160}
                    className="mt-2.5 size-40 rounded-xl border border-line bg-white p-2"
                  />
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[13px] font-semibold text-navy">
                      Can&apos;t scan it? Enter a key instead
                    </summary>
                    <p className="mt-2 text-[13px] text-muted">
                      Account: {enrol.account}
                      <br />
                      Key:{' '}
                      <code className="font-mono text-[13px] tracking-wider break-all text-ink">
                        {enrol.secret.match(/.{1,4}/g).join(' ')}
                      </code>
                    </p>
                  </details>
                </EnrolStep>
                <EnrolStep n={3}>Enter the 6-digit code the app shows.</EnrolStep>
              </ol>

              <CodeField value={code} onChange={setCode} error={fieldErrors.code} />

              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Checking…' : 'Turn on and sign in'}
              </button>
              <div className="mt-5">
                <button type="button" onClick={startOver} className={linkButtonClass}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, error, input }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="mb-4">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {input({
        id,
        className: inputClass,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error ? errorId : undefined,
      })}
      {error && (
        <p id={errorId} className="mt-1.5 text-[13px] font-medium text-red">
          {error}
        </p>
      )}
    </div>
  );
}

function CodeField({ value, onChange, error }) {
  return (
    <Field
      label="6-digit code"
      error={error}
      input={(props) => (
        <input
          {...props}
          className={`${props.className} text-center font-mono text-2xl tracking-[0.5em]`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="••••••"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      )}
    />
  );
}

function ErrorAlert({ error }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mb-5 rounded-r-lg border-l-[3px] border-red bg-red-soft px-3.5 py-3 text-[13.5px] text-ink"
    >
      {ERROR_TEXT[error] ?? 'Something went wrong. Please try again.'}
    </div>
  );
}

function Note({ children }) {
  return (
    <div className="mt-5 rounded-r-lg border-l-[3px] border-orange bg-orange-soft px-3.5 py-3 text-[12.5px] text-muted">
      {children}
    </div>
  );
}

function EnrolStep({ n, children }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-bold text-white"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
