import { describe, expect, it } from 'vitest';
import {
  groupFindings,
  hasCritical,
  verdict,
  type SecurityFinding,
  type SecurityScan,
} from '@/lib/security';

const f = (
  id: string,
  severity: SecurityFinding['severity'],
): SecurityFinding => ({ id, severity, title: id, detail: id });
const scan = (findings: SecurityFinding[], over: Partial<SecurityScan> = {}) =>
  ({
    at: '2026-11-02T00:00:00Z',
    findings,
    hostChecked: true,
    ...over,
  }) as SecurityScan;

describe('groupFindings', () => {
  it('puts the worst first and leaves out empty groups', () => {
    const g = groupFindings([
      f('a', 'info'),
      f('b', 'critical'),
      f('c', 'info'),
    ]);
    expect(g.map((x) => x.severity)).toEqual(['critical', 'info']);
    expect(g[1].findings.map((x) => x.id)).toEqual(['a', 'c']);
    expect(groupFindings([])).toEqual([]);
  });
});

describe('verdict', () => {
  it('asks for a first check when there is none', () => {
    expect(verdict(scan([], { at: null })).tone).toBe('none');
  });
  it('is bad with a critical finding, and says to treat the machine as compromised', () => {
    const v = verdict(scan([f('x', 'critical'), f('y', 'critical')]));
    expect(v.tone).toBe('bad');
    expect(v.text).toMatch(/2 things need action/);
    expect(v.text).toMatch(/compromised/);
  });
  it('is a warning for warnings alone, and good for none', () => {
    expect(verdict(scan([f('x', 'warning')])).tone).toBe('warn');
    expect(verdict(scan([f('i', 'info')])).tone).toBe('good');
  });
  it('never claims the machine is clean, and says when only the apps were looked at', () => {
    expect(verdict(scan([])).text).toMatch(/not proof/);
    expect(verdict(scan([], { hostChecked: false })).text).toMatch(
      /could not be checked/,
    );
  });
});

describe('hasCritical', () => {
  it('is only for a critical finding', () => {
    expect(hasCritical(null)).toBe(false);
    expect(hasCritical(scan([f('w', 'warning')]))).toBe(false);
    expect(hasCritical(scan([f('c', 'critical')]))).toBe(true);
  });
});
