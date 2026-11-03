import { describe, expect, it } from 'vitest';
import { statusOf } from '@/app/(dashboard)/apps/app-row';

describe('statusOf', () => {
  it('trusts what Docker reports, not the instance count', () => {
    expect(
      statusOf({ building: false, instanceCount: 1, runState: 'failed' }),
    ).toBe('failed');
    expect(
      statusOf({ building: false, instanceCount: 1, runState: 'starting' }),
    ).toBe('starting');
    expect(
      statusOf({ building: false, instanceCount: 1, runState: 'running' }),
    ).toBe('running');
  });
  it('keeps building and stopped first', () => {
    expect(
      statusOf({ building: true, instanceCount: 1, runState: 'failed' }),
    ).toBe('building');
    expect(
      statusOf({ building: false, instanceCount: 0, runState: 'failed' }),
    ).toBe('stopped');
  });
  it('treats an unknown state as running', () => {
    expect(statusOf({ building: false, instanceCount: 1 })).toBe('running');
  });
  it('says unhealthy when it runs but its health check fails, and starting while a check is still starting', () => {
    const base = {
      building: false,
      instanceCount: 1,
      runState: 'running' as const,
    };
    expect(statusOf({ ...base, health: 'unhealthy' })).toBe('unhealthy');
    expect(statusOf({ ...base, health: 'starting' })).toBe('starting');
    expect(statusOf({ ...base, health: 'healthy' })).toBe('running');
    expect(statusOf({ ...base, health: 'none' })).toBe('running');
  });
  it('lets a failing task, a deploy or a stop outrank health', () => {
    expect(
      statusOf({
        building: false,
        instanceCount: 1,
        runState: 'failed',
        health: 'unhealthy',
      }),
    ).toBe('failed');
    expect(
      statusOf({
        building: true,
        instanceCount: 1,
        runState: 'running',
        health: 'unhealthy',
      }),
    ).toBe('building');
    expect(
      statusOf({
        building: false,
        instanceCount: 0,
        runState: 'running',
        health: 'unhealthy',
      }),
    ).toBe('stopped');
  });
});
