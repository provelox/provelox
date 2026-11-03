import { apiHost, displayRef, parseImageRef } from './image-ref';

describe('parseImageRef', () => {
  it('reads Docker Hub names, official and not', () => {
    expect(parseImageRef('nginx')).toEqual({
      registry: 'docker.io',
      repo: 'library/nginx',
      tag: 'latest',
      digest: null,
    });
    expect(parseImageRef('mysql:8')).toMatchObject({
      repo: 'library/mysql',
      tag: '8',
    });
    expect(parseImageRef('acme/web:1.2')).toMatchObject({
      registry: 'docker.io',
      repo: 'acme/web',
      tag: '1.2',
    });
    expect(parseImageRef('index.docker.io/acme/web:1')).toMatchObject({
      registry: 'docker.io',
      repo: 'acme/web',
    });
  });
  it('reads other registries, with ports and deep paths', () => {
    expect(parseImageRef('ghcr.io/provelox/provelox:0.3.3')).toEqual({
      registry: 'ghcr.io',
      repo: 'provelox/provelox',
      tag: '0.3.3',
      digest: null,
    });
    expect(parseImageRef('localhost:5001/provelox:t')).toMatchObject({
      registry: 'localhost:5001',
      repo: 'provelox',
      tag: 't',
    });
    expect(parseImageRef('registry.example.com:5000/a/b/c:9')).toMatchObject({
      registry: 'registry.example.com:5000',
      repo: 'a/b/c',
      tag: '9',
    });
  });
  it('reads a digest, with or without a tag', () => {
    const d = 'sha256:' + 'a'.repeat(64);
    expect(parseImageRef(`nginx:1.2@${d}`)).toMatchObject({
      tag: '1.2',
      digest: d,
    });
    expect(parseImageRef(`acme/web@${d}`)).toMatchObject({
      tag: null,
      digest: d,
    });
  });
  it('refuses what is not a reference', () => {
    for (const bad of [
      '',
      'a b',
      'UPPER/case',
      'nginx:',
      'x@sha256:short',
      'http://evil/x',
    ])
      expect(parseImageRef(bad)).toBeNull();
  });
});

describe('names', () => {
  it('shows the short form and finds the API host', () => {
    expect(displayRef(parseImageRef('nginx:1')!)).toBe('nginx:1');
    expect(displayRef(parseImageRef('ghcr.io/a/b:2')!)).toBe('ghcr.io/a/b:2');
    expect(apiHost('docker.io')).toBe('registry-1.docker.io');
    expect(apiHost('ghcr.io')).toBe('ghcr.io');
  });
});
