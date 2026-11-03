import {
  acmeErrorFor,
  checkDns,
  diagnose,
  explainAcmeError,
  PENDING_GRACE_SECONDS,
  type DiagnosisInput,
} from './certificate-diagnosis';

const base: DiagnosisInput = {
  host: 'shop.example.org',
  ssl: true,
  state: 'pending',
  proxyEnabled: true,
  acmeEmailSet: true,
  dns: { state: 'match', addresses: ['1.2.3.4'], expected: ['1.2.3.4'] },
  pendingSeconds: 10,
  acmeError: null,
};
const d = (over: Partial<DiagnosisInput>) => diagnose({ ...base, ...over });

describe('checkDns', () => {
  const resolver = (table: Record<string, string[]>) => async (h: string) =>
    table[h] ?? [];
  it('says match, elsewhere, none and unknown', async () => {
    const r = resolver({
      'app.example.com': ['1.2.3.4'],
      'a.org': ['1.2.3.4'],
      'b.org': ['9.9.9.9'],
    });
    expect((await checkDns('a.org', 'app.example.com', r)).state).toBe('match');
    expect((await checkDns('b.org', 'app.example.com', r)).state).toBe(
      'elsewhere',
    );
    expect((await checkDns('c.org', 'app.example.com', r)).state).toBe('none');
    // the default address itself does not resolve: nothing to compare with
    expect((await checkDns('a.org', 'nope.example.com', r)).state).toBe(
      'unknown',
    );
    expect((await checkDns('a.org', null, r)).state).toBe('unknown');
  });
});

describe('diagnose', () => {
  it('says HTTPS is off before anything else', () => {
    expect(d({ ssl: false, state: 'off' })).toMatchObject({
      verdict: 'off',
      reason: 'https-off',
    });
  });

  it('reports an issued certificate, one that should have renewed, and an expired one', () => {
    expect(d({ state: 'valid' })).toMatchObject({ verdict: 'issued' });
    expect(d({ state: 'expiring' })).toMatchObject({
      verdict: 'warning',
      reason: 'expiring',
    });
    expect(d({ state: 'expired' })).toMatchObject({
      verdict: 'failed',
      reason: 'expired',
    });
  });

  it('names a missing Lets Encrypt email as the cause, ahead of DNS', () => {
    const r = d({
      acmeEmailSet: false,
      dns: { state: 'none', addresses: [], expected: ['1.2.3.4'] },
    });
    expect(r).toMatchObject({ verdict: 'failed', reason: 'no-email' });
    expect(r.message).toMatch(/email/i);
  });

  it('says the proxy is off when the platform does not run one', () => {
    expect(d({ proxyEnabled: false })).toMatchObject({ reason: 'proxy-off' });
    expect(d({ proxyEnabled: false, state: 'unreachable' })).toMatchObject({
      reason: 'proxy-off',
    });
  });

  it('says DNS is missing, and where it points when it points elsewhere', () => {
    expect(
      d({ dns: { state: 'none', addresses: [], expected: ['1.2.3.4'] } }),
    ).toMatchObject({
      verdict: 'failed',
      reason: 'dns-none',
    });
    const e = d({
      dns: {
        state: 'elsewhere',
        addresses: ['9.9.9.9'],
        expected: ['1.2.3.4'],
      },
    });
    expect(e).toMatchObject({ reason: 'dns-elsewhere' });
    expect(e.message).toContain('9.9.9.9');
    expect(e.message).toContain('1.2.3.4');
    expect(e.message).toMatch(/Cloudflare/); // being behind a proxy on purpose can be fine
  });

  it('waits while DNS is right and the wait is young, then calls it stuck', () => {
    expect(d({ pendingSeconds: 5 })).toMatchObject({
      verdict: 'waiting',
      reason: 'waiting',
    });
    const stuck = d({ pendingSeconds: PENDING_GRACE_SECONDS + 1 });
    expect(stuck).toMatchObject({ verdict: 'failed', reason: 'stuck' });
    // the causes it can only suggest are named as possibilities
    expect(stuck.message).toMatch(/port 80/);
    expect(stuck.message).toMatch(/limit/);
  });

  it('does not claim DNS is right when it could not be checked', () => {
    const r = d({
      dns: { state: 'unknown', addresses: [], expected: [] },
      pendingSeconds: 5,
    });
    expect(r.verdict).toBe('waiting');
    expect(r.message).toMatch(/not confirmed/);
  });

  it('puts the proxys own error first, explained, with its text kept', () => {
    const r = d({
      acmeError:
        'acme: error: 400 :: urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for shop.example.org',
    });
    expect(r).toMatchObject({ verdict: 'failed', reason: 'acme-error' });
    expect(r.acme?.kind).toBe('dns');
    expect(r.acme?.raw).toContain('NXDOMAIN');
  });
});

describe('acmeErrorFor', () => {
  const line = (host: string, err: string) =>
    `2026-10-24T01:00:00Z ERR Unable to obtain ACME certificate for domains error="${err}" ACME CA=https://acme-v02.api.letsencrypt.org/directory domains=["${host}"] providerName=le.acme`;

  it('finds the newest failure for the host and quotes the error part', () => {
    const lines = [
      line('shop.example.org', 'first attempt failed'),
      line('other.example.org', 'not this host'),
      line(
        'shop.example.org',
        'one or more domains had a problem:\\n[shop.example.org] acme: error: 400 :: urn:ietf:params:acme:error:connection :: Timeout during connect',
      ),
    ];
    const found = acmeErrorFor('shop.example.org', lines);
    expect(found).toContain('Timeout during connect');
    expect(found).not.toContain('\\n');
    expect(found).not.toContain('first attempt');
  });

  it('is null when the log has nothing for the host, and never invents one', () => {
    expect(acmeErrorFor('shop.example.org', [])).toBeNull();
    expect(
      acmeErrorFor('shop.example.org', [
        line('other.example.org', 'x'),
        'INF shop.example.org configured',
      ]),
    ).toBeNull();
  });

  it('keeps it short', () => {
    const long = acmeErrorFor('a.example.org', [
      line('a.example.org', 'x'.repeat(2000)),
    ]);
    expect(long!.length).toBeLessThanOrEqual(600);
  });
});

describe('explainAcmeError', () => {
  const kind = (t: string) => explainAcmeError('h.example.org', t).kind;
  it('tells the causes apart', () => {
    expect(
      kind(
        'urn:ietf:params:acme:error:rateLimited :: too many failed authorizations',
      ),
    ).toBe('rate-limit');
    expect(
      kind('urn:ietf:params:acme:error:dns :: NXDOMAIN looking up A'),
    ).toBe('dns');
    expect(
      kind(
        'urn:ietf:params:acme:error:connection :: Timeout during connect (likely firewall problem)',
      ),
    ).toBe('connection');
    expect(
      kind(
        'urn:ietf:params:acme:error:unauthorized :: Invalid response from http://h/.well-known 404',
      ),
    ).toBe('challenge');
    expect(kind('CAA record for h.example.org prevents issuance')).toBe('caa');
    expect(kind('something nobody has seen')).toBe('other');
  });
});
