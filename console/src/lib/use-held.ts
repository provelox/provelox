'use client';

import { useEffect, useRef } from 'react';

/**
 * The value, or the last one it had when it goes empty. A dialog that is open for "the thing in state" is closed by
 * clearing that state, and the dialog then spends a moment fading out: without this its title and text go blank (and
 * it changes size) while it is still on screen. The remembered value is only used until the dialog has left.
 */
export function useHeld<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  useEffect(() => {
    if (value !== null) last.current = value;
  });
  return value ?? last.current;
}
