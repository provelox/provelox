import { describe, expect, it } from 'vitest';
import { formatVersion } from '@/lib/version';

describe('formatVersion', () => {
  it('puts a v in front of a release number', () => {
    expect(formatVersion('0.2.5')).toBe('v0.2.5');
    expect(formatVersion('0.3.0-rc.1')).toBe('v0.3.0-rc.1');
  });
  it('leaves named builds alone, and says when it is not known', () => {
    expect(formatVersion('edge')).toBe('edge');
    expect(formatVersion('dev')).toBe('dev');
    expect(formatVersion(null)).toBe('version unknown');
    expect(formatVersion(undefined)).toBe('version unknown');
  });
});
