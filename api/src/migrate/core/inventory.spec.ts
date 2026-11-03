import { formatInventory, inventory, inventoryJson } from './inventory';
import { app, withData, withPorts } from './test-apps';

describe('inventory', () => {
  const inv = inventory([
    app({ name: 'web', env: [{ key: 'SECRET', value: 'hunter2' }] }),
    withData('db'),
    withPorts('dns'),
    app({ name: 'bad', blocker: 'Name cannot be used.' }),
    app({ name: 'odd', attention: ['Has a custom config.'] }),
  ]);
  const by = (n: string) => inv.apps.find((e) => e.app.name === n)!;

  it('classifies apps', () => {
    expect(by('web').class).toBe('ready');
    expect(by('db').class).toBe('has-data');
    expect(by('dns').class).toBe('needs-attention');
    expect(by('bad').class).toBe('needs-attention');
    expect(by('odd').class).toBe('needs-attention');
    expect(inv.counts).toEqual({
      ready: 1,
      'has-data': 1,
      'needs-attention': 3,
    });
  });

  it('never prints environment values', () => {
    expect(formatInventory(inv)).toContain('SECRET');
    expect(formatInventory(inv)).not.toContain('hunter2');
    expect(JSON.stringify(inventoryJson(inv))).not.toContain('hunter2');
  });

  it('lists apps by name', () => {
    expect(inv.apps.map((e) => e.app.name)).toEqual([
      'bad',
      'db',
      'dns',
      'odd',
      'web',
    ]);
  });
});
