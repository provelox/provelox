/**
 * Keyboard shortcuts of the console, and the small state machine that reads them. It is pure (no DOM, no clock of its
 * own) so every case can be tested; `use-shortcuts.ts` feeds it real key presses.
 *
 * Single keys (`n`, `/`, `?`) act at once; `g` starts a two-key sequence ("go to") that waits a moment for its second
 * key. Nothing fires while someone is typing in a field or holding a modifier, so it never gets in the way of text.
 */

export type ShortcutCommand =
  | { type: 'go'; href: string }
  | { type: 'new-app' }
  | { type: 'search' }
  | { type: 'help' };

export interface Shortcut {
  /** What is pressed, as written in the help dialog: "g a", "n", "?" */
  keys: string;
  label: string;
  group: 'Go to' | 'Do' | 'Find';
  command: ShortcutCommand;
}

export const SHORTCUTS: Shortcut[] = [
  {
    keys: 'g a',
    label: 'Apps',
    group: 'Go to',
    command: { type: 'go', href: '/apps' },
  },
  {
    keys: 'g t',
    label: 'Templates',
    group: 'Go to',
    command: { type: 'go', href: '/templates' },
  },
  {
    keys: 'g s',
    label: 'Settings',
    group: 'Go to',
    command: { type: 'go', href: '/settings' },
  },
  { keys: 'n', label: 'New app', group: 'Do', command: { type: 'new-app' } },
  {
    keys: '/',
    label: 'Search this page (or open the command palette)',
    group: 'Find',
    command: { type: 'search' },
  },
  {
    keys: '?',
    label: 'Show these shortcuts',
    group: 'Do',
    command: { type: 'help' },
  },
];

/** The shortcut for a place, for the hint beside it in the palette and sidebar: "g a" for /apps. */
export const hintForHref = (href: string): string | undefined =>
  SHORTCUTS.find((s) => s.command.type === 'go' && s.command.href === href)
    ?.keys;

/** How long `g` waits for the key after it. */
export const SEQUENCE_MS = 1200;

export interface KeyState {
  /** When `g` was pressed, while a sequence is open */
  pendingSince: number | null;
}

export const initialKeyState: KeyState = { pendingSince: null };

export interface KeyInput {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Focus is in a text field, a select or an editable area */
  typing: boolean;
  /** Something modal is open (a dialog, the palette): keys belong to it */
  blocked: boolean;
  now: number;
}

export interface KeyResult {
  state: KeyState;
  command?: ShortcutCommand;
  /** The key was used, so the page should not also act on it */
  handled: boolean;
}

const find = (keys: string) => SHORTCUTS.find((s) => s.keys === keys);

export function readKey(state: KeyState, input: KeyInput): KeyResult {
  const idle = { pendingSince: null };
  if (input.typing || input.blocked || input.meta || input.ctrl || input.alt)
    return { state: idle, handled: false };

  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const waiting =
    state.pendingSince !== null &&
    input.now - state.pendingSince <= SEQUENCE_MS;

  if (waiting) {
    const hit = find(`g ${key}`);
    // whatever follows ends the sequence; only a known second key does something
    return hit
      ? { state: idle, command: hit.command, handled: true }
      : { state: idle, handled: false };
  }

  if (key === 'g') return { state: { pendingSince: input.now }, handled: true };
  // "?" is shift+/ on most keyboards: the key itself says which
  const hit = key.length === 1 ? find(key) : undefined;
  if (hit) return { state: idle, command: hit.command, handled: true };
  return { state: idle, handled: false };
}

/** The search box of the page, if it has one: the first match of these, in the order given. */
export const SEARCH_SELECTORS = [
  '[data-shortcut-search]',
  'input[aria-label="Filter apps"]',
  'input[aria-label="Search templates"]',
];
