import { describe, expect, it } from 'vitest';
import {
  activityQuery,
  failureText,
  filtersFrom,
  groupByDay,
  renamedTo,
  todayText,
  wordsFor,
  type ActivityEvent,
} from '@/lib/activity';

const ev = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 1,
  at: '2030-03-05T12:00:00.000Z',
  actor: { kind: 'admin', name: 'admin' },
  action: 'app.deploy',
  target: 'api',
  outcome: 'ok',
  status: 200,
  summary: '',
  ...over,
});

describe('wordsFor', () => {
  it('words an action and links an app to its page', () => {
    expect(wordsFor(ev())).toEqual({ verb: 'deployed', href: '/apps/api' });
    expect(wordsFor(ev({ action: 'secret.set', target: 'api' }))).toEqual({
      verb: 'set a secret on',
      href: '/apps/api',
    });
    expect(wordsFor(ev({ action: 'app.env.update' })).verb).toBe(
      'changed the variables of',
    );
  });

  it('links a collection by its id and a project by its name', () => {
    expect(
      wordsFor(ev({ action: 'group.update', target: 'g_abc1234567' })).href,
    ).toBe('/collections/g_abc1234567');
    expect(
      wordsFor(ev({ action: 'project.update', target: 'blog' })).href,
    ).toBe('/projects/blog');
  });

  it('does not link what is gone, or what has no page', () => {
    expect(wordsFor(ev({ action: 'app.delete' })).href).toBeNull();
    expect(
      wordsFor(ev({ action: 'group.delete', target: 'g_x' })).href,
    ).toBeNull();
    expect(
      wordsFor(ev({ action: 'platform.domain.set', target: null })).href,
    ).toBeNull();
    // but a secret removed from an app that still exists leads to the app
    expect(wordsFor(ev({ action: 'secret.delete' })).href).toBe('/apps/api');
  });

  it('encodes what goes into an address', () => {
    expect(wordsFor(ev({ target: 'a/b?c' })).href).toBe('/apps/a%2Fb%3Fc');
  });

  it('makes an action nobody wrote words for readable', () => {
    expect(wordsFor(ev({ action: 'widgets.frobnicate-all' })).verb).toBe(
      'widgets frobnicate all',
    );
  });
});

describe('renamedTo', () => {
  it('finds the new name of a renamed app, and the old name does not link', () => {
    const e = ev({
      action: 'app.rename',
      target: 'old',
      summary: 'to new-name',
    });
    expect(renamedTo(e)).toBe('new-name');
    expect(wordsFor(e).href).toBeNull();
    expect(renamedTo(ev())).toBeNull();
    expect(renamedTo(ev({ action: 'app.rename', summary: '' }))).toBeNull();
  });
});

describe('activityQuery and filtersFrom', () => {
  it('leaves out empty filters and carries the cursor', () => {
    expect(activityQuery({})).toBe('');
    expect(
      activityQuery({ app: 'api', outcome: 'failed' }, { before: 40 }),
    ).toBe('app=api&outcome=failed&before=40');
  });

  it('reads filters out of a page address and drops what is not one of ours', () => {
    expect(
      filtersFrom({
        app: 'api',
        action: 'secret',
        outcome: 'ok',
        actor: ['hub', 'x'],
        junk: '1',
      }),
    ).toEqual({ app: 'api', action: 'secret', outcome: 'ok', actor: 'hub' });
    expect(
      filtersFrom({ action: 'a b%', outcome: 'maybe', app: '  ' }),
    ).toEqual({
      app: undefined,
      action: undefined,
      actor: undefined,
      outcome: undefined,
    });
  });
});

describe('groupByDay', () => {
  it('puts events under Today, Yesterday and then the date, newest first', () => {
    const now = new Date('2030-03-05T15:00:00');
    const events = [
      ev({ id: 4, at: new Date('2030-03-05T10:00:00').toISOString() }),
      ev({ id: 3, at: new Date('2030-03-05T09:00:00').toISOString() }),
      ev({ id: 2, at: new Date('2030-03-04T20:00:00').toISOString() }),
      ev({ id: 1, at: new Date('2030-02-20T08:00:00').toISOString() }),
    ];
    const groups = groupByDay(events, now);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual([
      'Today',
      'Yesterday',
    ]);
    expect(groups.map((g) => g.events.length)).toEqual([2, 1, 1]);
    expect(groups[2].label).not.toMatch(/Today|Yesterday/);
  });
});

describe('failureText and todayText', () => {
  it('says what a failure was in a few words', () => {
    expect(failureText(404)).toBe('Failed: not found');
    expect(failureText(400)).toBe('Refused: invalid');
    expect(failureText(500)).toBe('Failed: server error');
    expect(failureText(418)).toBe('Failed (418)');
  });
  it('counts the last day for the overview', () => {
    expect(todayText(0, 200)).toBe('No changes in the last day');
    expect(todayText(1, 200)).toBe('1 change in the last day');
    expect(todayText(12, 200)).toBe('12 changes in the last day');
    expect(todayText(200, 200)).toBe('200+ changes in the last day');
  });
});
