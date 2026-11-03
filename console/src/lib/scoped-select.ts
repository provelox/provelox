import type { KeyboardEvent } from 'react';

/**
 * Props for a scrolling box of text (logs, build output): it can take focus, and Select all inside it selects only its
 * text. Without this, Ctrl/Cmd+A selects the whole page, since a plain box is never the focused element.
 */
export const scopedSelectAll = {
  tabIndex: 0,
  onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
    const selection = window.getSelection();
    if (!selection) return;
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(e.currentTarget);
    selection.removeAllRanges();
    selection.addRange(range);
  },
} as const;

/** Keyboard focus should be visible on such a box, but a click should not draw a ring around it. */
export const SCOPED_BOX_FOCUS =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
