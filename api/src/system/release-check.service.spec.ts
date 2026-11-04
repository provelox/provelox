import { ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';
import {
  FORCE_EVERY_MS,
  FRESH_MS,
  isCareful,
  ReleaseCheckService,
  RETRY_MS,
  stepOf,
  type ReleaseFetch,
} from './release-check.service';

const GITHUB_NOTES = 'https://github.com/provelox/provelox/releases/tag/v0.5.1';

/** A release server that answers what the test says, and remembers what it was asked */
function setup(
  running: string | null = '0.5.0',
  env: Record<string, string> = {},
) {
  if (running === null) delete process.env.PROVELOX_VERSION;
  else process.env.PROVELOX_VERSION = running;
  const s = makeStack(env);
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: () => Promise<Response> | Response = () => release('0.5.1');
  const http: ReleaseFetch = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  const make = () => new ReleaseCheckService(s.docker, s.cfg, s.settings, http);
  return {
    s,
    calls,
    svc: make(),
    make,
    answer: (f: () => Promise<Response> | Response) => (answer = f),
  };
}

const release = (tag: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      tag_name: `v${tag}`,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/provelox/provelox/releases/tag/v${tag}`,
      published_at: '2026-11-03T22:00:00Z',
      body: 'x'.repeat(30_000),
      ...extra,
    }),
    { status: 200 },
  );

const original = process.env.PROVELOX_VERSION;
afterEach(() => {
  if (original === undefined) delete process.env.PROVELOX_VERSION;
  else process.env.PROVELOX_VERSION = original;
});

describe('how big a step a release is', () => {
  it('names the step', () => {
    expect(stepOf('0.5.0', '0.5.1')).toBe('patch');
    expect(stepOf('0.5.0', '0.6.0')).toBe('minor');
    expect(stepOf('0.5.0', '1.0.0')).toBe('major');
    // a candidate and its own release differ only in what follows the dash
    expect(stepOf('0.5.0-rc.23', '0.5.0')).toBe('patch');
  });

  it('asks for care before 1.0 on a minor step, and always on a major one', () => {
    expect(isCareful('0.5.0', '0.5.1')).toBe(false);
    expect(isCareful('0.5.0-rc.23', '0.5.0')).toBe(false);
    expect(isCareful('0.5.0', '0.6.0')).toBe(true);
    expect(isCareful('1.2.0', '1.3.0')).toBe(false);
    expect(isCareful('1.9.0', '2.0.0')).toBe(true);
  });
});

describe('ReleaseCheckService', () => {
  it('finds a newer release and links to what changed', async () => {
    const t = setup('0.5.0');
    const r = await t.svc.report();
    expect(r).toMatchObject({
      enabled: true,
      current: '0.5.0',
      latest: '0.5.1',
      updateAvailable: true,
      step: 'patch',
      careful: false,
      notesUrl: GITHUB_NOTES,
      publishedAt: '2026-11-03T22:00:00.000Z',
      error: null,
    });
    expect(r.checkedAt).not.toBeNull();
  });

  it('sees the release as an update for a release candidate of it', async () => {
    const t = setup('0.5.0-rc.23');
    t.answer(() => release('0.5.0'));
    expect(await t.svc.report()).toMatchObject({
      current: '0.5.0-rc.23',
      latest: '0.5.0',
      updateAvailable: true,
      step: 'patch',
      careful: false,
    });
  });

  it('warns before a minor step while the project is before 1.0', async () => {
    const t = setup('0.5.0');
    t.answer(() => release('0.6.0'));
    expect(await t.svc.report()).toMatchObject({
      step: 'minor',
      careful: true,
    });
  });

  it('offers nothing when the server is on the newest release, or ahead of it', async () => {
    const t = setup('0.5.1');
    expect((await t.svc.report()).updateAvailable).toBe(false);
    const ahead = setup('0.6.0-rc.1');
    expect((await ahead.svc.report()).updateAvailable).toBe(false);
  });

  it('never offers an update to a build that is not a release', async () => {
    for (const v of [null, 'dev', '', 'edge']) {
      const t = setup(v);
      const r = await t.svc.report();
      expect(r.current).toBeNull();
      expect(r.updateAvailable).toBe(false);
    }
  });

  it('asks the one configured address, saying who is asking and nothing else', async () => {
    const t = setup('0.5.0');
    await t.svc.report();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(t.s.cfg.RELEASES_URL);
    expect(t.s.cfg.RELEASES_URL).toBe(
      'https://api.github.com/repos/provelox/provelox/releases/latest',
    );
    expect(t.calls[0].init.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'provelox/0.5.0',
    });
    expect(t.calls[0].init.body).toBeUndefined();
    expect(t.calls[0].init.method).toBeUndefined();
  });

  it('does not believe a candidate, a draft or a tag that is not a release number', async () => {
    for (const extra of [
      { prerelease: true },
      { draft: true },
      { tag_name: 'latest' },
      { tag_name: 'v1.x' },
      { tag_name: 42 },
    ]) {
      const t = setup('0.5.0');
      t.answer(() => release('0.9.0', extra));
      const r = await t.svc.report();
      expect(r.latest).toBeNull();
      expect(r.updateAvailable).toBe(false);
      expect(r.error).toMatch(/not understood/);
    }
  });

  it('links to the release notes only on github.com over https', async () => {
    for (const [html_url, expected] of [
      [GITHUB_NOTES, GITHUB_NOTES],
      ['http://github.com/x', null],
      ['https://evil.example/releases', null],
      ['javascript:alert(1)', null],
      [42, null],
    ] as const) {
      const t = setup('0.5.0');
      t.answer(() => release('0.5.1', { html_url }));
      expect((await t.svc.report()).notesUrl).toBe(expected);
    }
  });

  it('says plainly why a look failed, and keeps what it last learned', async () => {
    const t = setup('0.5.0');
    await t.svc.report(1000);
    t.answer(() => {
      throw new Error('connect ECONNREFUSED 140.82.1.1:443');
    });
    const failed = await t.svc.force(1000 + FORCE_EVERY_MS);
    expect(failed.error).toMatch(/Could not reach the server/);
    expect(failed.error).not.toMatch(/ECONNREFUSED|140\.82/);
    // the older answer is still shown
    expect(failed).toMatchObject({ latest: '0.5.1', updateAvailable: true });
    expect(failed.checkedAt).toBeNull();
  });

  it('explains a refusal for too many requests', async () => {
    const t = setup('0.5.0');
    t.answer(() => new Response('', { status: 403 }));
    expect((await t.svc.report()).error).toMatch(/answered 403.*too many/);
    const other = setup('0.5.0');
    other.answer(() => new Response('', { status: 500 }));
    expect((await other.svc.report()).error).toBe(
      'The server that publishes releases answered 500.',
    );
  });

  it('refuses an answer that is not JSON or is far too large', async () => {
    const t = setup('0.5.0');
    t.answer(() => new Response('<html>', { status: 200 }));
    expect((await t.svc.report()).error).toMatch(/not understood/);
    const big = setup('0.5.0');
    big.answer(() => new Response('x'.repeat(1_000_001), { status: 200 }));
    expect((await big.svc.report()).error).toMatch(/far too large/);
  });

  it('answers from memory for six hours, then looks again behind the call', async () => {
    const t = setup('0.5.0');
    const t0 = 1_000_000;
    await t.svc.report(t0);
    await t.svc.report(t0 + FRESH_MS - 1);
    expect(t.calls).toHaveLength(1);
    t.answer(() => release('0.5.2'));
    // stale: this call still answers from memory, and a look runs behind it
    expect((await t.svc.report(t0 + FRESH_MS + 1)).latest).toBe('0.5.1');
    await new Promise((r) => setImmediate(r));
    expect(t.calls).toHaveLength(2);
    expect((await t.svc.report(t0 + FRESH_MS + 2)).latest).toBe('0.5.2');
  });

  it('tries again half an hour after a failure, not before', async () => {
    const t = setup('0.5.0');
    t.answer(() => new Response('', { status: 500 }));
    const t0 = 5_000_000;
    await t.svc.report(t0);
    await t.svc.report(t0 + RETRY_MS - 1);
    expect(t.calls).toHaveLength(1);
    await t.svc.report(t0 + RETRY_MS + 1);
    await new Promise((r) => setImmediate(r));
    expect(t.calls).toHaveLength(2);
  });

  it('does one look at a time', async () => {
    const t = setup('0.5.0');
    let release_!: () => void;
    const gate = new Promise<void>((r) => (release_ = r));
    t.answer(async () => {
      await gate;
      return release('0.5.1');
    });
    const a = t.svc.report(10);
    const b = t.svc.report(11);
    release_();
    await Promise.all([a, b]);
    expect(t.calls).toHaveLength(1);
  });

  it('honours "check now" at most once a minute', async () => {
    const t = setup('0.5.0');
    const t0 = 9_000_000;
    await t.svc.force(t0);
    await t.svc.force(t0 + FORCE_EVERY_MS - 1);
    expect(t.calls).toHaveLength(1);
    await t.svc.force(t0 + FORCE_EVERY_MS);
    expect(t.calls).toHaveLength(2);
  });

  describe('turning it off', () => {
    it('makes no request at all while switched off in Settings, and says so', async () => {
      const t = setup('0.5.0');
      expect(t.svc.setEnabled(false)).toEqual({ enabled: false });
      const r = await t.svc.report();
      const f = await t.svc.force();
      expect(t.calls).toHaveLength(0);
      expect(r).toMatchObject({
        enabled: false,
        lockedOff: false,
        latest: null,
        updateAvailable: false,
        error: null,
      });
      expect(f.enabled).toBe(false);
    });

    it('forgets what it learned when switched off, and learns again when switched on', async () => {
      const t = setup('0.5.0');
      await t.svc.report();
      t.svc.setEnabled(false);
      t.svc.setEnabled(true);
      const r = await t.svc.report();
      expect(t.calls).toHaveLength(2);
      expect(r.updateAvailable).toBe(true);
    });

    it('stays off when the environment says UPDATE_CHECK=false, whatever Settings says', async () => {
      const t = setup('0.5.0', { UPDATE_CHECK: 'false' });
      expect(t.s.cfg.UPDATE_CHECK).toBe(false);
      const r = await t.svc.report();
      expect(t.calls).toHaveLength(0);
      expect(r).toMatchObject({ enabled: false, lockedOff: true });
      expect(() => t.svc.setEnabled(true)).toThrow(ValidationError);
      expect(() => t.svc.setEnabled(true)).toThrow(/UPDATE_CHECK=false/);
      // turning it off is always fine
      expect(t.svc.setEnabled(false)).toEqual({ enabled: false });
    });

    it('remembers the choice (it lives in the settings, not in memory)', async () => {
      const t = setup('0.5.0');
      t.svc.setEnabled(false);
      expect(t.make().enabled()).toBe(false);
    });
  });

  describe('what the server runs', () => {
    const running = (image: string | null) => (name: string) =>
      name === 'pvx-provelox' && image
        ? ({ desired: 1, running: 1, state: 'running', image } as const)
        : null;

    it('says an update can be started when the API runs as a service', async () => {
      const t = setup('0.5.0');
      t.s.docker.statusOverride = running('ghcr.io/provelox/provelox:0.5.0');
      expect(await t.svc.report()).toMatchObject({
        updateAvailable: true,
        canUpdate: true,
        imageMoved: false,
      });
    });

    it('says when it cannot (the API is not a Swarm service)', async () => {
      const t = setup('0.5.0');
      t.s.docker.statusOverride = running(null);
      expect(await t.svc.report()).toMatchObject({
        updateAvailable: true,
        canUpdate: false,
        imageMoved: false,
      });
    });

    it('notices the old image name, which gets no more releases', async () => {
      const t = setup('0.5.0');
      t.s.docker.statusOverride = running(
        'ghcr.io/floms/provelox:0.5.0@sha256:' + 'a'.repeat(64),
      );
      expect(await t.svc.report()).toMatchObject({
        updateAvailable: true,
        imageMoved: true,
      });
    });

    it('does not mistake a mirror of the image for the old name', async () => {
      const t = setup('0.5.0');
      t.s.docker.statusOverride = running(
        'registry.example.com/mirror/provelox:0.5.0',
      );
      expect((await t.svc.report()).imageMoved).toBe(false);
    });

    it('does not look at the service when there is nothing to update to', async () => {
      const t = setup('0.5.1');
      let asked = 0;
      t.s.docker.statusOverride = (n) => {
        asked++;
        return running('ghcr.io/provelox/provelox:0.5.1')(n);
      };
      await t.svc.report();
      expect(asked).toBe(0);
    });
  });
});
