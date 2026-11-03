import { describe, expect, it } from 'vitest';
import {
  findDuplicate,
  normalizeRegistryDomain,
  registryDomainProblem,
  registryForImage,
  registryOf,
  toPublicRegistry,
  type PublicRegistry,
} from '@/lib/registries';

const regs: PublicRegistry[] = [
  { id: 'r_1', registryUser: 'bot', registryDomain: 'ghcr.io', createdAt: '' },
  { id: 'r_2', registryUser: 'me', registryDomain: 'docker.io', createdAt: '' },
];

describe('toPublicRegistry', () => {
  it('maps the API shape and carries no password', () => {
    const r = toPublicRegistry({
      id: 'r_1',
      domain: 'ghcr.io',
      username: 'bot',
      createdAt: 'c',
    });
    expect(r).toEqual({
      id: 'r_1',
      registryUser: 'bot',
      registryDomain: 'ghcr.io',
      createdAt: 'c',
    });
    expect(JSON.stringify(r)).not.toMatch(/password/i);
  });
});

describe('normalizeRegistryDomain / registryDomainProblem', () => {
  it('strips scheme, path and case, and keeps a port', () => {
    expect(normalizeRegistryDomain('https://GHCR.io/')).toBe('ghcr.io');
    expect(normalizeRegistryDomain(' registry.example.com:5000/x ')).toBe(
      'registry.example.com:5000',
    );
  });
  it('explains what is wrong', () => {
    expect(registryDomainProblem('')).toMatch(/Enter the registry/);
    expect(registryDomainProblem('not a domain')).toMatch(/just the domain/);
    expect(registryDomainProblem('ghcr.io')).toBeNull();
    expect(registryDomainProblem('localhost:5000')).toBeNull();
  });
});

describe('registryOf / registryForImage', () => {
  it.each([
    ['nginx', 'docker.io'],
    ['acme/app:1', 'docker.io'],
    ['ghcr.io/acme/app:1', 'ghcr.io'],
    ['index.docker.io/acme/app', 'docker.io'],
    ['localhost:5000/app', 'localhost:5000'],
  ])('%s → %s', (image, host) => expect(registryOf(image)).toBe(host));

  it('finds the registry whose host the image points at', () => {
    expect(registryForImage(regs, 'ghcr.io/acme/app:1')?.id).toBe('r_1');
    expect(registryForImage(regs, 'acme/app')?.id).toBe('r_2');
    expect(registryForImage(regs, 'registry.other.com/app')).toBeUndefined();
  });
});

describe('findDuplicate', () => {
  it('matches the same host ignoring case, and ignores the one being edited', () => {
    expect(findDuplicate(regs, 'GHCR.io')?.id).toBe('r_1');
    expect(findDuplicate(regs, 'ghcr.io', 'r_1')).toBeUndefined();
    expect(findDuplicate(regs, 'quay.io')).toBeUndefined();
  });
});

describe('providerOf', () => {
  it.each([
    ['ghcr.io', 'ghcr'],
    ['docker.io', 'dockerhub'],
    ['registry.gitlab.com', 'gitlab'],
    ['europe-west1-docker.pkg.dev', 'google'],
    ['eu.gcr.io', 'google'],
    ['123456789012.dkr.ecr.eu-west-1.amazonaws.com', 'ecr'],
    ['acmereg.azurecr.io', 'azure'],
    ['quay.io', 'quay'],
    ['registry.digitalocean.com', 'digitalocean'],
    ['registry.example.com:5000', 'custom'],
  ])('%s is %s', async (domain, id) => {
    const { providerOf } = await import('@/lib/registries');
    expect(providerOf(domain).id).toBe(id);
  });
});

describe('checkRegistryInput', () => {
  const get = async (id: string) => {
    const m = await import('@/lib/registries');
    return { ...m, preset: m.REGISTRY_PRESETS.find((p) => p.id === id)! };
  };

  it('accepts a good GitHub login and nudges a token of another shape', async () => {
    const { checkRegistryInput, preset } = await get('ghcr');
    const base = { domain: 'ghcr.io', user: 'me' };
    const fine = checkRegistryInput(
      preset,
      { ...base, secret: 'ghp_abc' },
      { editing: false },
    );
    expect(fine.ok).toBe(true);
    expect(fine.warning).toBeUndefined();
    const odd = checkRegistryInput(
      preset,
      { ...base, secret: 'hunter2' },
      { editing: false },
    );
    expect(odd.ok).toBe(true);
    expect(odd.warning).toMatch(/personal access token/);
  });

  it('refuses spaces in a token and an address that is not the provider’s', async () => {
    const { checkRegistryInput, preset } = await get('azure');
    const r = checkRegistryInput(
      preset,
      { domain: 'registry.example.com', user: 'u', secret: 'a b' },
      { editing: false },
    );
    expect(r.domain).toMatch(/azurecr/);
    expect(r.secret).toMatch(/no spaces/);
    expect(r.ok).toBe(false);
  });

  it('wants the whole key file for Google, and fills the username itself', async () => {
    const { checkRegistryInput, preset } = await get('google');
    expect(preset.fixedUser).toBe('_json_key');
    const bad = checkRegistryInput(
      preset,
      { domain: 'europe-west1-docker.pkg.dev', user: '', secret: 'nope' },
      { editing: false },
    );
    expect(bad.secret).toMatch(/JSON/);
    const good = checkRegistryInput(
      preset,
      {
        domain: 'europe-west1-docker.pkg.dev',
        user: '',
        secret: JSON.stringify({ client_email: 'a@b', private_key: 'k' }),
      },
      { editing: false },
    );
    expect(good.ok).toBe(true);
  });

  it('points at the registry already added instead of adding it twice', async () => {
    const { checkRegistryInput, preset } = await get('ghcr');
    const r = checkRegistryInput(
      preset,
      { domain: 'ghcr.io', user: 'me', secret: 'ghp_x' },
      { editing: false, existing: regs },
    );
    expect(r.domain).toMatch(/already added/);
    expect(r.ok).toBe(false);
  });

  it('on edit, an empty password is fine (the saved one is kept)', async () => {
    const { checkRegistryInput, preset } = await get('ghcr');
    expect(
      checkRegistryInput(
        preset,
        { domain: 'ghcr.io', user: 'me', secret: '' },
        { editing: true },
      ).ok,
    ).toBe(true);
  });
});
