import { describe, expect, it } from 'vitest';
import {
  deployPhase,
  firstInvalidStep,
  initialWizardState,
  parsePort,
  problemWith,
} from '@/lib/wizard';

const base = { ...initialWizardState(null), name: 'my-api' };

describe('wizard validation', () => {
  it('needs a valid, unused name', () => {
    expect(problemWith('basics', initialWizardState(null), [])).toMatch(
      /name/i,
    );
    expect(problemWith('basics', { ...base, name: 'Other.com' }, [])).toMatch(
      /dots/,
    );
    expect(problemWith('basics', base, ['my-api'])).toMatch(/already exists/);
    expect(problemWith('basics', base, [])).toBeNull();
  });
  it('validates the port', () => {
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('0')).toBeNull();
    expect(parsePort('70000')).toBeNull();
    expect(parsePort('80a')).toBeNull();
    expect(problemWith('runtime', { ...base, port: '' }, [])).toMatch(/port/);
  });
  it('only asks for an image when deploying now', () => {
    expect(problemWith('deploy', base, [])).toBeNull();
    expect(
      problemWith('deploy', { ...base, image: 'bad image!' }, []),
    ).toBeNull();
    const now = { ...base, deployNow: true };
    expect(problemWith('deploy', now, [])).toMatch(/Enter the image/);
    expect(problemWith('deploy', { ...now, image: 'bad image!' }, [])).toMatch(
      /valid image/,
    );
    expect(
      problemWith('deploy', { ...now, image: 'nginx:latest' }, []),
    ).toBeNull();
  });
  it('finds the first step that needs fixing', () => {
    expect(firstInvalidStep(base, [])).toBeNull();
    expect(
      firstInvalidStep(
        { ...base, port: 'x', deployNow: true, image: '??' },
        [],
      ),
    ).toBe('runtime');
    expect(firstInvalidStep({ ...base, name: '' }, [])).toBe('basics');
  });
});

describe('deployPhase', () => {
  const st = (
    o: Partial<{
      isAppBuilding: boolean;
      isBuildFailed: boolean;
      lines: string[];
    }>,
  ) => ({
    isAppBuilding: false,
    isBuildFailed: false,
    lines: ['x'],
    ...o,
  });
  it('is waiting before there is anything to report, so polling continues', () => {
    expect(deployPhase(undefined)).toBe('waiting');
    expect(deployPhase(st({ lines: [] }))).toBe('waiting');
    // even a "not building" answer with no lines is not a finished deploy
    expect(deployPhase(st({ lines: [], isAppBuilding: false }))).toBe(
      'waiting',
    );
  });
  it('is running while building, done when it ends well and failed when it does not', () => {
    expect(deployPhase(st({ isAppBuilding: true }))).toBe('running');
    expect(deployPhase(st({}))).toBe('done');
    expect(deployPhase(st({ isBuildFailed: true }))).toBe('failed');
  });
});

describe('default address', () => {
  it('starts as the platform setting for new apps', () => {
    expect(initialWizardState(null).defaultSubdomain).toBe(true);
    expect(initialWizardState(null, false).defaultSubdomain).toBe(false);
  });
});

describe('a domain typed as the name', () => {
  it('starts with none, and only a real domain passes', () => {
    const s = initialWizardState(null);
    expect(s.domain).toBe('');
    expect(problemWith('basics', { ...s, name: 'loxti-api' }, [])).toBeNull();
    expect(
      problemWith(
        'basics',
        { ...s, name: 'loxti-api', domain: 'api.loxti.com' },
        [],
      ),
    ).toBeNull();
    expect(
      problemWith('basics', { ...s, name: 'loxti-api', domain: 'nope' }, []),
    ).toMatch(/domain/i);
  });
});
