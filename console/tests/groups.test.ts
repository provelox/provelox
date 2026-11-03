import { describe, expect, it } from 'vitest';
import {
  addGroup,
  assignApp,
  deleteGroup,
  emptyGroups,
  explainGroupName,
  groupOfApp,
  parseGroupsFile,
  partition,
  removeApp,
  renameGroup,
} from '@/lib/groups';

const withShop = () => addGroup(emptyGroups(), 'g1', '  Shop ');

describe('group names', () => {
  it('trims and collapses spaces', () => {
    expect(withShop().groups[0].name).toBe('Shop');
    expect(addGroup(emptyGroups(), 'g', 'My   Product').groups[0].name).toBe(
      'My Product',
    );
  });
  it('rejects empty, too long and duplicate (any case) names', () => {
    expect(explainGroupName('  ', emptyGroups())).toMatch(/name/);
    expect(explainGroupName('x'.repeat(41), emptyGroups())).toMatch(/at most/);
    expect(explainGroupName('SHOP', withShop())).toMatch(/already exists/);
    expect(() => addGroup(withShop(), 'g2', 'shop')).toThrow(/already exists/);
  });
  it('lets a group keep its own name when renamed', () => {
    expect(renameGroup(withShop(), 'g1', 'SHOP').groups[0].name).toBe('SHOP');
    expect(() => renameGroup(withShop(), 'nope', 'x')).toThrow(/not found/);
  });
});

describe('assigning apps', () => {
  it('keeps an app in at most one group', () => {
    let f = addGroup(withShop(), 'g2', 'Other');
    f = assignApp(f, 'api', 'g1');
    f = assignApp(f, 'api', 'g2');
    expect(groupOfApp(f, 'api')?.id).toBe('g2');
    expect(f.groups.find((g) => g.id === 'g1')?.appNames).toEqual([]);
  });
  it('removes an app from its group with null', () => {
    const f = removeApp(assignApp(withShop(), 'api', 'g1'), 'api');
    expect(groupOfApp(f, 'api')).toBeUndefined();
  });
  it('refuses an unknown group', () => {
    expect(() => assignApp(withShop(), 'api', 'zzz')).toThrow(/not found/);
  });
  it('deleting a group only drops the group', () => {
    const f = deleteGroup(assignApp(withShop(), 'api', 'g1'), 'g1');
    expect(f.groups).toEqual([]);
  });
});

describe('partition', () => {
  const apps = ['api', 'site', 'portal', 'other'].map((appName) => ({
    appName,
  }));
  it('splits live apps and ignores apps that no longer exist', () => {
    let f = addGroup(emptyGroups(), 'g1', 'Shop');
    f = assignApp(f, 'api', 'g1');
    f = assignApp(f, 'gone', 'g1');
    f = assignApp(f, 'portal', 'g1');
    const { groups, ungrouped } = partition(f, apps);
    expect(groups[0].apps.map((a) => a.appName)).toEqual(['api', 'portal']);
    expect(ungrouped.map((a) => a.appName)).toEqual(['site', 'other']);
  });
  it('lists groups alphabetically', () => {
    let f = addGroup(emptyGroups(), 'b', 'Zeta');
    f = addGroup(f, 'a', 'Alpha');
    expect(partition(f, []).groups.map((g) => g.group.name)).toEqual([
      'Alpha',
      'Zeta',
    ]);
  });
});

describe('parseGroupsFile', () => {
  it('survives garbage', () => {
    expect(parseGroupsFile(null)).toEqual({ groups: [] });
    expect(parseGroupsFile({ groups: 'x' })).toEqual({ groups: [] });
  });
  it('keeps an app only in the first group that lists it', () => {
    const f = parseGroupsFile({
      groups: [
        { id: 'a', name: 'A', appNames: ['x'] },
        { id: 'b', name: 'B', appNames: ['x', 'y'] },
      ],
    });
    expect(f.groups.map((g) => g.appNames)).toEqual([['x'], ['y']]);
  });
  it('drops malformed and duplicate entries and de-duplicates apps', () => {
    const f = parseGroupsFile({
      groups: [
        { id: 'a', name: 'One', appNames: ['x', 'x', 5] },
        { id: 'a', name: 'Dup', appNames: [] },
        { name: 'no id' },
      ],
    });
    expect(f.groups).toEqual([{ id: 'a', name: 'One', appNames: ['x'] }]);
  });
});
