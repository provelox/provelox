import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: () => ({ PROVELOX_API_URL: 'http://api:4000' }),
}));

import { isApiDown } from '../src/lib/availability';
import { BackendError } from '../src/lib/backend';
import {
  formatWait,
  nextDelayMs,
  SLOW_AFTER_SECONDS,
} from '../src/lib/waiting';

describe('isApiDown', () => {
  it('is true when the API could not be reached or the proxy answered for it', () => {
    for (const status of [0, 502, 503, 504])
      expect(isApiDown(new BackendError(status, 'x'))).toBe(true);
  });
  it('is false for an answer from the API, and for anything else', () => {
    for (const status of [400, 401, 403, 404, 409, 500])
      expect(isApiDown(new BackendError(status, 'x'))).toBe(false);
    expect(isApiDown(new Error('boom'))).toBe(false);
    expect(isApiDown(undefined)).toBe(false);
    expect(isApiDown({ digest: 'NEXT_REDIRECT;replace;/login' })).toBe(false);
  });
});

describe('waiting', () => {
  it('asks quickly at first and eases off to a ceiling', () => {
    expect(nextDelayMs(0)).toBe(1500);
    expect(nextDelayMs(4)).toBe(3500);
    expect(nextDelayMs(100)).toBe(8000);
  });
  it('shows the wait as minutes and seconds', () => {
    expect(formatWait(7)).toBe('0:07');
    expect(formatWait(65)).toBe('1:05');
    expect(formatWait(750)).toBe('12:30');
    expect(formatWait(-3)).toBe('0:00');
  });
  it('calls a wait slow after a minute', () => {
    expect(SLOW_AFTER_SECONDS).toBe(60);
  });
});
