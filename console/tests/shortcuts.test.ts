import { describe, expect, it } from 'vitest';
import {
  hintForHref,
  initialKeyState,
  readKey,
  SEQUENCE_MS,
  SHORTCUTS,
  type KeyInput,
  type KeyState,
} from '@/lib/shortcuts';

const press = (
  state: KeyState,
  key: string,
  over: Partial<KeyInput> = {},
  now = 1000,
) =>
  readKey(state, {
    key,
    meta: false,
    ctrl: false,
    alt: false,
    typing: false,
    blocked: false,
    now,
    ...over,
  });

describe('single keys', () => {
  it('n opens a new app, ? opens the help, / searches', () => {
    expect(press(initialKeyState, 'n').command).toEqual({ type: 'new-app' });
    expect(press(initialKeyState, '?').command).toEqual({ type: 'help' });
    expect(press(initialKeyState, '/').command).toEqual({ type: 'search' });
  });

  it('ignores capitals the same way, since Shift is how ? is typed', () => {
    expect(press(initialKeyState, 'N').command).toEqual({ type: 'new-app' });
  });

  it('does nothing for a key that is not one of ours', () => {
    const r = press(initialKeyState, 'x');
    expect(r.command).toBeUndefined();
    expect(r.handled).toBe(false);
  });
});

describe('go to', () => {
  it.each([
    ['a', '/apps'],
    ['t', '/templates'],
    ['s', '/settings'],
  ])('g then %s goes to %s', (second, href) => {
    const first = press(initialKeyState, 'g');
    expect(first.handled).toBe(true);
    expect(first.command).toBeUndefined();
    expect(press(first.state, second, {}, 1500).command).toEqual({
      type: 'go',
      href,
    });
  });

  it('forgets the g after a moment', () => {
    const first = press(initialKeyState, 'g', {}, 1000);
    const late = press(first.state, 'a', {}, 1000 + SEQUENCE_MS + 1);
    expect(late.command).toBeUndefined();
  });

  it('a wrong second key ends the sequence without doing anything', () => {
    const first = press(initialKeyState, 'g');
    const wrong = press(first.state, 'z', {}, 1100);
    expect(wrong.command).toBeUndefined();
    expect(wrong.state.pendingSince).toBeNull();
    // and the key after that is a fresh start, not the second half of the old sequence
    expect(press(wrong.state, 'a', {}, 1200).command).toBeUndefined();
  });

  it('g g does not trap you: the second g is not a command either', () => {
    const first = press(initialKeyState, 'g');
    const again = press(first.state, 'g', {}, 1100);
    expect(again.command).toBeUndefined();
    expect(again.state.pendingSince).toBeNull();
  });
});

describe('when keys belong to someone else', () => {
  it.each([
    ['typing in a field', { typing: true }],
    ['a dialog is open', { blocked: true }],
    ['Cmd is held', { meta: true }],
    ['Ctrl is held', { ctrl: true }],
    ['Alt is held', { alt: true }],
  ])('does nothing while %s', (_, over) => {
    const r = press(initialKeyState, 'n', over);
    expect(r.command).toBeUndefined();
    expect(r.handled).toBe(false);
  });

  it('typing in the middle of a sequence cancels it', () => {
    const first = press(initialKeyState, 'g');
    const typed = press(first.state, 'a', { typing: true }, 1100);
    expect(typed.command).toBeUndefined();
    expect(typed.state.pendingSince).toBeNull();
  });
});

describe('the list', () => {
  it('has unique keys and a hint for every place you can go to', () => {
    const keys = SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(hintForHref('/apps')).toBe('g a');
    expect(hintForHref('/templates')).toBe('g t');
    expect(hintForHref('/settings')).toBe('g s');
    expect(hintForHref('/nowhere')).toBeUndefined();
  });
});
