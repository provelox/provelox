import {
  certificateStep,
  conditionOf,
  messageFor,
  step,
  type Tracker,
} from './transitions';

const view = (
  instanceCount: number,
  status: { state: string; health?: string } | null,
) => ({
  app: { instanceCount },
  status,
});

describe('conditionOf', () => {
  it('reads how an app is doing', () => {
    expect(conditionOf(view(1, { state: 'running', health: 'healthy' }))).toBe(
      'ok',
    );
    expect(conditionOf(view(1, { state: 'running' }))).toBe('ok');
    expect(
      conditionOf(view(1, { state: 'running', health: 'unhealthy' })),
    ).toBe('unhealthy');
    expect(conditionOf(view(1, { state: 'failed' }))).toBe('failed');
    expect(conditionOf(view(1, { state: 'starting' }))).toBe('pending');
    expect(conditionOf(view(1, { state: 'running', health: 'starting' }))).toBe(
      'pending',
    );
    expect(conditionOf(view(0, { state: 'stopped' }))).toBe('stopped');
  });
  it('treats an app that should run but has no service as failing', () => {
    expect(conditionOf(view(1, null))).toBe('failed');
    expect(conditionOf(view(0, null))).toBe('stopped');
  });
});

describe('step', () => {
  const run = (conditions: Parameters<typeof step>[2][]) => {
    let t: Tracker | undefined;
    return conditions.map((c) => {
      const r = step('web', t, c);
      t = r.next;
      return r.event?.type ?? null;
    });
  };

  it('does not report a blip, reports a problem that lasts, and only once', () => {
    expect(run(['ok', 'failed', 'ok'])).toEqual([null, null, null]);
    expect(run(['ok', 'failed', 'failed', 'failed', 'failed'])).toEqual([
      null,
      null,
      'problem',
      null,
      null,
    ]);
  });

  it('reports the recovery after a reported problem, and not otherwise', () => {
    expect(run(['failed', 'failed', 'ok', 'ok'])).toEqual([
      null,
      'problem',
      'recovered',
      null,
    ]);
    expect(run(['failed', 'ok', 'ok'])).toEqual([null, null, null]);
  });

  it('says nothing for an app that is stopped on purpose or still starting', () => {
    expect(run(['failed', 'failed', 'stopped', 'ok'])).toEqual([
      null,
      'problem',
      null,
      null,
    ]);
    expect(run(['ok', 'pending', 'pending', 'ok'])).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('says what the problem is', () => {
    let t: Tracker | undefined;
    t = step('web', t, 'unhealthy').next;
    expect(step('web', t, 'unhealthy').event).toEqual({
      type: 'problem',
      app: 'web',
      problem: 'unhealthy',
    });
  });
});

describe('certificateStep', () => {
  const c = (state: string, days?: number) =>
    ({ host: 'a.test', state, daysLeft: days }) as never;

  it('speaks when a certificate starts to run out and when it has, once each', () => {
    let level;
    let r = certificateStep(level, c('valid', 60));
    expect(r.event).toBeUndefined();
    level = r.level;
    r = certificateStep(level, c('expiring', 9));
    expect(r.event).toMatchObject({ level: 'expiring', daysLeft: 9 });
    level = r.level;
    expect(certificateStep(level, c('expiring', 8)).event).toBeUndefined();
    r = certificateStep(level, c('expired'));
    expect(r.event).toMatchObject({ level: 'expired' });
  });

  it('forgets after a renewal, so the next run-down is reported again', () => {
    const renewed = certificateStep('expiring', c('valid', 80));
    expect(renewed.level).toBe('ok');
    expect(
      certificateStep(renewed.level, c('expiring', 10)).event,
    ).toBeDefined();
  });

  it('keeps its last level when the host could not be checked', () => {
    expect(certificateStep('expiring', c('unreachable')).level).toBe(
      'expiring',
    );
    expect(certificateStep('expiring', c('pending')).event).toBeUndefined();
  });
});

describe('messageFor', () => {
  it('writes a plain title and a sentence for each event', () => {
    expect(
      messageFor({ type: 'problem', app: 'web', problem: 'failed' }).title,
    ).toBe('web is failing');
    expect(
      messageFor({ type: 'problem', app: 'web', problem: 'unhealthy' }).text,
    ).toMatch(/health check/);
    expect(messageFor({ type: 'recovered', app: 'web' }).title).toBe(
      'web is back',
    );
    expect(
      messageFor({ type: 'certificate', host: 'a.test', level: 'expired' })
        .title,
    ).toMatch(/expired/);
    expect(
      messageFor({
        type: 'certificate',
        host: 'a.test',
        level: 'expiring',
        daysLeft: 1,
      }).text,
    ).toMatch(/1 day /);
  });
});
