import { unsafeTarget } from './url-safety';

const t = (u: string) => unsafeTarget(new URL(u));

describe('unsafeTarget', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.0.1/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://0.0.0.0:8080/',
    'http://[::]/',
    'http://[::ffff:169.254.169.254]/',
    'http://2852039166/', // 169.254.169.254 as one number
    'http://0xA9FEA9FE/',
  ])('refuses %s', (u) => expect(t(u)).not.toBeNull());

  it.each([
    'https://hooks.example.com/abc',
    'http://10.0.0.5:4000/',
    'http://192.168.1.2/',
    'http://127.0.0.1:4710/',
    'http://provelox:4000/',
    'http://[2001:db8::1]/',
  ])('allows %s', (u) => expect(t(u)).toBeNull());
});
