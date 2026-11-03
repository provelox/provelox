import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';

describe('GroupsService', () => {
  it('creates, lists alphabetically and trims names', () => {
    const { groups } = makeStack();
    groups.create('  Zeta  ');
    groups.create('Alpha');
    expect(groups.list().map((g) => g.name)).toEqual(['Alpha', 'Zeta']);
  });
  it('rejects empty, long and duplicate (any case) names', () => {
    const { groups } = makeStack();
    groups.create('Shop');
    expect(() => groups.create('  ')).toThrow(ValidationError);
    expect(() => groups.create('x'.repeat(41))).toThrow(ValidationError);
    expect(() => groups.create('SHOP')).toThrow(ConflictError);
  });
  it('renames, keeping its own name allowed', () => {
    const { groups } = makeStack();
    const g = groups.create('Shop');
    expect(groups.rename(g.id, 'SHOP').name).toBe('SHOP');
    expect(() => groups.rename('nope', 'x')).toThrow(NotFoundError);
  });
  it('ensure returns the existing group or creates one', () => {
    const { groups } = makeStack();
    const a = groups.ensure('shop');
    expect(groups.ensure('SHOP').id).toBe(a.id);
  });
  it('deleting a group only ungroups its apps', async () => {
    const { groups, apps } = makeStack();
    const g = groups.create('Shop');
    await apps.create({ name: 'backend', groupId: g.id });
    expect(groups.list()[0].apps).toEqual(['backend']);
    groups.remove(g.id);
    expect(groups.list()).toEqual([]);
    expect(apps.getDefinition('backend').groupId).toBeNull();
    expect(() => groups.remove(g.id)).toThrow(NotFoundError);
  });
  it('apps can only join groups that exist, and moving never touches Docker', async () => {
    const { groups, apps, docker } = makeStack();
    await expect(
      apps.create({ name: 'a', groupId: 'g_missing' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await apps.create({ name: 'a' });
    const g = groups.create('Shop');
    const before = docker.calls.length;
    await apps.update('a', { groupId: g.id });
    expect(apps.getDefinition('a').groupId).toBe(g.id);
    expect(docker.calls.length).toBe(before);
    await expect(
      apps.update('a', { groupId: 'g_missing' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await apps.update('a', { groupId: null });
    expect(apps.getDefinition('a').groupId).toBeNull();
  });
});
