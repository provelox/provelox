import { describe, expect, it } from 'vitest';
import { checkAdvertise, checkManager, joinCommands } from '@/lib/join-command';

describe('checkManager', () => {
  it('adds the default port and keeps one that is given', () => {
    expect(checkManager('203.0.113.10')).toEqual({
      ok: true,
      address: '203.0.113.10:2377',
    });
    expect(checkManager(' mgr.example.com:2378 ')).toEqual({
      ok: true,
      address: 'mgr.example.com:2378',
    });
    expect(checkManager('[2001:db8::1]')).toEqual({
      ok: true,
      address: '[2001:db8::1]:2377',
    });
  });
  it('rejects what is not an address', () => {
    for (const bad of ['', 'a b', 'host:0', 'host:99999', 'http://x', '-x'])
      expect(checkManager(bad).ok).toBe(false);
  });
});

describe('checkAdvertise', () => {
  it('allows nothing, an address or an interface name', () => {
    expect(checkAdvertise('')).toEqual({ ok: true, value: '' });
    expect(checkAdvertise('203.0.113.20').ok).toBe(true);
    expect(checkAdvertise('eth0').ok).toBe(true);
    expect(checkAdvertise('2001:db8::2').ok).toBe(true);
  });
  it('rejects anything that could be more than an address', () => {
    for (const bad of ['1.2.3.4 --rm', '$(id)', 'a;b', '1.2.3.4/24', 'x y'])
      expect(checkAdvertise(bad).ok).toBe(false);
  });
});

describe('joinCommands', () => {
  it('builds both commands, with the new server’s address when given', () => {
    const c = joinCommands(
      'SWMTKN-1-x',
      'ghcr.io/provelox/provelox:0.2.23',
      '10.0.0.1:2377',
      '10.0.0.9',
    );
    expect(c.provelox).toBe(
      'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:0.2.23 join --token SWMTKN-1-x --manager 10.0.0.1:2377 --advertise-addr 10.0.0.9',
    );
    expect(c.swarm).toBe(
      'docker swarm join --token SWMTKN-1-x --advertise-addr 10.0.0.9 10.0.0.1:2377',
    );
    expect(joinCommands('T', 'i', 'm:1', '').swarm).toBe(
      'docker swarm join --token T m:1',
    );
  });
});
