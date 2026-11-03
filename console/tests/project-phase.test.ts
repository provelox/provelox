import { describe, expect, it } from 'vitest';
import { projectPhase } from '@/components/projects/project-progress';

const s = (...states: string[]) =>
  states.map((state) => ({ state })) as { state: 'running' }[];

describe('projectPhase', () => {
  it('waits until services are reported, so polling continues', () => {
    expect(projectPhase(undefined)).toBe('waiting');
    expect(projectPhase([])).toBe('waiting');
  });
  it('is running only when every service runs', () => {
    expect(projectPhase(s('running', 'running'))).toBe('running');
    expect(projectPhase(s('running', 'starting'))).toBe('starting');
    expect(projectPhase(s('stopped'))).toBe('starting');
  });
  it('failure wins over everything else', () => {
    expect(projectPhase(s('running', 'failed', 'starting'))).toBe('failed');
  });
});
