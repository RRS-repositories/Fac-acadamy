import { useRef } from 'react';

/*
 * The two sign-in tabs from the approved prototype: "👤 Staff member" and
 * "🛡 Manager", styled like its .btn-navy / .btn-ghost small buttons.
 *
 * The tab is a statement of intent and nothing more. It decides which copy the
 * card shows and where the user lands after signing in. It never grants
 * anything: the role comes from the CRM account, the server decides it, and
 * every manager route and manager API call checks it again. There is no
 * passcode field here and there never will be.
 */

export const STAFF_TAB = 'staff';
export const MANAGER_TAB = 'manager';

const TABS = [
  { id: STAFF_TAB, emoji: '👤', label: 'Staff member' },
  { id: MANAGER_TAB, emoji: '🛡', label: 'Manager' },
];

const STORAGE_KEY = 'fac-academy:signin-tab';

/** The tab last used on this device, defaulting to Staff. */
export function readRememberedTab() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === MANAGER_TAB ? MANAGER_TAB : STAFF_TAB;
  } catch {
    // Storage can throw in a private window. Then we simply don't remember.
    return STAFF_TAB;
  }
}

export function rememberTab(tab) {
  try {
    window.localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // Not remembered on this device; the tab still works for this visit.
  }
}

/** The id of a tab's button, so the panel can name the tab it belongs to. */
export function tabButtonId(tab) {
  return `signin-tab-${tab}`;
}

const tabBase =
  'inline-flex items-center justify-center gap-2 rounded-lg border-[1.5px] px-[13px] py-[7px] text-xs font-bold transition-colors';
const tabSelected = `${tabBase} border-transparent bg-navy text-white hover:bg-navy-mid`;
const tabUnselected = `${tabBase} border-line bg-transparent text-navy hover:border-navy hover:bg-white`;

export default function SignInTabs({ value, onChange, panelId }) {
  const buttons = useRef({});

  function select(tab) {
    onChange(tab);
    buttons.current[tab]?.focus();
  }

  // Left/right (and up/down) move between tabs, Home/End jump to the ends —
  // the usual keyboard behaviour for a tablist.
  function onKeyDown(event) {
    const index = TABS.findIndex((tab) => tab.id === value);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      select(TABS[(index + 1) % TABS.length].id);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(TABS[(index - 1 + TABS.length) % TABS.length].id);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(TABS[0].id);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(TABS[TABS.length - 1].id);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Sign in as"
      onKeyDown={onKeyDown}
      className="mb-5 flex flex-wrap gap-2"
    >
      {TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[tab.id] = node;
            }}
            id={tabButtonId(tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={selected ? tabSelected : tabUnselected}
          >
            <span aria-hidden="true">{tab.emoji}</span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
