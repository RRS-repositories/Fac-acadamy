import { badgeBase, cardClass } from '../training/styles.js';

/*
 * The three switches that decide how the academy behaves, shown read-only
 * (Section 07 item 4). They are set in the server's environment and changed by
 * IT with Brad's sign-off — there is deliberately no control here, because a
 * dashboard toggle would be a production change made by accident.
 */

const SETTINGS = [
  {
    key: 'stage1AuthRequired',
    name: 'STAGE1_AUTH_REQUIRED',
    on: 'Stage 1 needs the authenticator',
    off: 'Stage 1 opens without the authenticator',
    hint: 'Whether a new starter must finish authenticator setup before Stage 1.',
  },
  {
    key: 'academyV2',
    name: 'ACADEMY_V2',
    on: 'The portal is open',
    off: 'The portal is switched off',
    hint: 'The master switch. Off means nobody can sign in to the academy.',
  },
  {
    key: 'provisioning',
    name: 'ACADEMY_PROVISIONING',
    on: 'New accounts are created automatically',
    off: 'Accounts are created by hand',
    hint: 'Whether a new starter gets their academy and Mattermost accounts on their own.',
  },
];

export default function ConfigStrip({ config }) {
  return (
    <section aria-labelledby="config-heading" className={`${cardClass} mt-6 px-6 py-5`}>
      <h2 id="config-heading" className="font-display text-base font-bold">
        How the academy is set up
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Read-only. These are server settings; IT changes them, and only with written sign-off.
      </p>
      <ul className="mt-4 grid gap-3 lg:grid-cols-3">
        {SETTINGS.map((setting) => {
          const value = config?.[setting.key];
          const known = typeof value === 'boolean';
          return (
            <li key={setting.key} className="rounded-[10px] border border-line px-4 py-3">
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[11.5px] font-bold text-navy">{setting.name}</code>
                <span
                  data-config={setting.key}
                  className={`${badgeBase} ${
                    !known
                      ? 'bg-[#EEF1F5] text-[#8A97A6]'
                      : value
                        ? 'bg-green-soft text-green'
                        : 'bg-[#EEF1F5] text-[#8A97A6]'
                  }`}
                >
                  {known ? (value ? 'On' : 'Off') : 'Unknown'}
                </span>
              </span>
              <p className="mt-1.5 text-[13px] font-semibold text-ink">
                {known ? (value ? setting.on : setting.off) : 'Not reported by the server.'}
              </p>
              <p className="mt-1 text-[12px] text-muted">{setting.hint}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
