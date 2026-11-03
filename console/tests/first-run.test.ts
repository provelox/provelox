import { describe, expect, it } from 'vitest';
import {
  buildChecklist,
  nextStep,
  progress,
  shouldShow,
  type FirstRunFacts,
} from '@/lib/first-run';

const empty: FirstRunFacts = {
  rootDomain: 'example.com',
  acmeEmail: '',
  apps: [],
  deployKeys: 0,
};

describe('the checklist ticks itself from real state', () => {
  it('starts with the domain step open when there is no certificate email', () => {
    const steps = buildChecklist(empty);
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['domain', false],
      ['app', false],
      ['deploy', false],
      ['key', false],
    ]);
    expect(nextStep(steps)?.id).toBe('domain');
    expect(steps[0].href).toBe('/settings/domain');
  });

  it('ticks the domain once the domain and the email are both set', () => {
    expect(
      buildChecklist({ ...empty, acmeEmail: 'ops@example.com' })[0].done,
    ).toBe(true);
    expect(
      buildChecklist({ ...empty, rootDomain: '', acmeEmail: 'a@b.co' })[0].done,
    ).toBe(false);
  });

  it('an app that exists but is not deployed leaves the deploy step open, and links to that app', () => {
    const steps = buildChecklist({
      ...empty,
      acmeEmail: 'ops@example.com',
      apps: [{ name: 'shop', deployed: false }],
    });
    expect(steps[1].done).toBe(true);
    expect(steps[2].done).toBe(false);
    expect(steps[2].href).toBe('/apps/shop/deploy');
    expect(steps[3].href).toBe('/apps/shop/deploy');
    expect(nextStep(steps)?.id).toBe('deploy');
  });

  it('any deployed app ticks the deploy step; any deploy key ticks the last', () => {
    const steps = buildChecklist({
      rootDomain: 'example.com',
      acmeEmail: 'ops@example.com',
      apps: [
        { name: 'a', deployed: false },
        { name: 'b', deployed: true },
      ],
      deployKeys: 1,
    });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(nextStep(steps)).toBeNull();
    expect(progress(steps)).toEqual({ done: 4, total: 4 });
  });

  it('with no app yet, the app-related steps point at creating one', () => {
    const steps = buildChecklist(empty);
    expect(steps[1].href).toBe('/apps?new=1');
    expect(steps[2].href).toBe('/apps?new=1');
    expect(steps[3].href).toBe('/settings/deploy-keys');
  });
});

describe('when it is shown', () => {
  it('always on an empty instance, until hidden or complete', () => {
    expect(shouldShow({ appCount: 0, complete: false, memory: {} })).toBe(true);
    expect(
      shouldShow({ appCount: 0, complete: false, memory: { dismissed: true } }),
    ).toBe(false);
    expect(shouldShow({ appCount: 0, complete: true, memory: {} })).toBe(false);
  });

  it('stays after the first app only if it was shown at the start', () => {
    expect(
      shouldShow({ appCount: 1, complete: false, memory: { started: true } }),
    ).toBe(true);
    expect(shouldShow({ appCount: 1, complete: false, memory: {} })).toBe(
      false,
    );
    // an instance that already runs several apps and never saw it is left alone
    expect(shouldShow({ appCount: 9, complete: false, memory: {} })).toBe(
      false,
    );
  });

  it('hiding it wins over everything', () => {
    expect(
      shouldShow({
        appCount: 1,
        complete: false,
        memory: { started: true, dismissed: true },
      }),
    ).toBe(false);
  });
});
