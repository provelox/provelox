import { imageRepository, parseImageRepository } from './image-repository';

describe('imageRepository', () => {
  it('drops the tag and the digest', () => {
    expect(imageRepository('ghcr.io/acme/web:1.2')).toBe('ghcr.io/acme/web');
    expect(imageRepository('ghcr.io/acme/web@sha256:abc123')).toBe(
      'ghcr.io/acme/web',
    );
    expect(imageRepository('ghcr.io/acme/web')).toBe('ghcr.io/acme/web');
  });

  it('keeps a registry port', () => {
    expect(imageRepository('localhost:5000/app:1')).toBe('localhost:5000/app');
    expect(imageRepository('localhost:5000/app')).toBe('localhost:5000/app');
  });
});

describe('parseImageRepository', () => {
  it('accepts repositories, with or without a tag', () => {
    expect(parseImageRepository('ghcr.io/acme/web')).toBe('ghcr.io/acme/web');
    expect(parseImageRepository(' ghcr.io/acme/web:latest ')).toBe(
      'ghcr.io/acme/web',
    );
    expect(parseImageRepository('nginx')).toBe('nginx');
    expect(parseImageRepository('localhost:5000/app')).toBe(
      'localhost:5000/app',
    );
  });

  it('refuses anything that is not a repository', () => {
    expect(parseImageRepository('')).toBeNull();
    expect(parseImageRepository('   ')).toBeNull();
    expect(parseImageRepository('ghcr.io/acme/web with spaces')).toBeNull();
    expect(parseImageRepository('../etc')).toBeNull();
    expect(parseImageRepository('ghcr.io/acme/$(whoami)')).toBeNull();
    expect(parseImageRepository('a'.repeat(300))).toBeNull();
  });
});
