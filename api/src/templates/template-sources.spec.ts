import { ConflictError, ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';
import { parseIndex, rawGitUrl, fetchText } from './source-index';

const COMPOSE = `services:
  web:
    image: nginx:alpine
    x-provelox:
      expose: true
      port: 80
`;

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'site',
  name: 'Site',
  mainService: 'web',
  publicWeb: true,
  compose: COMPOSE,
  ...over,
});

/** A fetch that serves a fixed set of files, and records what it was asked with */
function files(map: Record<string, string | number>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const v = map[String(url)];
    if (v === undefined) return new Response('no', { status: 404 });
    if (typeof v === 'number') return new Response('x', { status: v });
    return new Response(v, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('parseIndex', () => {
  it('keeps a template icon name, and refuses one that is not a plain name', () => {
    const r = parseIndex(
      JSON.stringify({
        templates: [
          entry({ icon: 'postgresql' }),
          entry({ id: 'b', icon: '../x' }),
          entry({ id: 'c', icon: 'https://example.com/logo.svg' }),
          entry({ id: 'd', icon: 'http://example.com/logo.svg' }),
          entry({ id: 'e', icon: 'https://u:p@example.com/logo.svg' }),
        ],
      }),
    );
    expect(r.entries[0].icon).toBe('postgresql');
    expect(r.entries.map((e) => e.id)).toEqual(['site', 'c']);
    expect(r.skipped.map((s) => s.id)).toEqual(['b', 'd', 'e']);
  });

  it('reads JSON and YAML, with defaults filled in', () => {
    const r = parseIndex(
      JSON.stringify({ name: 'Acme', templates: [entry()] }),
    );
    expect(r.name).toBe('Acme');
    expect(r.entries[0]).toMatchObject({
      id: 'site',
      category: 'Other',
      variables: [],
    });
    const y = parseIndex(
      `templates:\n  - id: a\n    name: A\n    mainService: web\n    compose: |\n      services: {}\n`,
    );
    expect(y.entries).toHaveLength(1);
  });

  it('skips a bad entry and says why, keeping the rest', () => {
    const r = parseIndex(
      JSON.stringify({
        templates: [
          entry(),
          entry({ id: 'Bad Id' }),
          entry({ id: 'site' }),
          entry({ id: 'nofile', compose: undefined }),
        ],
      }),
    );
    expect(r.entries.map((e) => e.id)).toEqual(['site']);
    expect(r.skipped.map((s) => s.id)).toEqual(['Bad Id', 'site', 'nofile']);
  });

  it('refuses what is not an index', () => {
    expect(() => parseIndex('{"nope": 1}')).toThrow(/templates/);
  });
});

describe('rawGitUrl', () => {
  it.each([
    [
      'https://github.com/acme/t',
      'https://raw.githubusercontent.com/acme/t/main/x.json',
    ],
    [
      'https://github.com/acme/t.git',
      'https://raw.githubusercontent.com/acme/t/main/x.json',
    ],
    [
      'https://gitlab.com/acme/t',
      'https://gitlab.com/acme/t/-/raw/main/x.json',
    ],
    [
      'https://bitbucket.org/acme/t',
      'https://bitbucket.org/acme/t/raw/main/x.json',
    ],
    [
      'https://git.example.com/acme/t',
      'https://git.example.com/acme/t/raw/branch/main/x.json',
    ],
  ])('%s', (repo, raw) => expect(rawGitUrl(repo, 'main', 'x.json')).toBe(raw));

  it('refuses things that are not a repository address', () => {
    expect(() => rawGitUrl('github.com/acme/t', 'main', 'x')).toThrow();
    expect(() => rawGitUrl('https://github.com/acme', 'main', 'x')).toThrow();
    expect(() => rawGitUrl('git@github.com:acme/t.git', 'main', 'x')).toThrow();
  });
});

describe('fetchText', () => {
  it('sends the token to the address it was given for, not to a redirect elsewhere', async () => {
    const seen: Record<string, string>[] = [];
    const impl = (async (url: URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      if (String(url) === 'https://a.example.com/i')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://b.example.com/i' },
        });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await fetchText('https://a.example.com/i', {
      token: 't',
      maxBytes: 100,
      fetchImpl: impl,
    });
    expect(seen[0].authorization).toBe('Bearer t');
    expect(seen[1].authorization).toBeUndefined();
  });

  it('never calls a cloud metadata address', async () => {
    const f = files({});
    await expect(
      fetchText('http://169.254.169.254/latest', {
        maxBytes: 100,
        fetchImpl: f.impl,
      }),
    ).rejects.toThrow(/Link-local/);
    expect(f.calls).toEqual([]);
  });

  it('refuses a file over the limit', async () => {
    const f = files({ 'https://a.example.com/i': 'x'.repeat(50) });
    await expect(
      fetchText('https://a.example.com/i', { maxBytes: 10, fetchImpl: f.impl }),
    ).rejects.toThrow(/too large/);
  });
});

describe('TemplateSourcesService', () => {
  const URL_ = 'https://templates.example.com/index.json';
  const setup = (map: Record<string, string | number>) => {
    const s = makeStack();
    const f = files(map);
    s.templateSources.fetchImpl = f.impl;
    return { ...s, f };
  };

  it('adds a registry by index address and offers its templates, with where they came from', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ name: 'Acme', templates: [entry()] }),
    });
    const v = await templateSources.add({ kind: 'index', url: URL_ });
    expect(v).toMatchObject({ name: 'Acme', templates: 1, hasToken: false });
    const [t] = templateSources.all();
    expect(t.id).toBe(`${v.id}:site`);
    expect(t.source).toEqual({ id: v.id, name: 'Acme' });
    expect(templateSources.byId(t.id)?.compose).toBe(COMPOSE);
  });

  it('reads a git repository through its raw address, with a token that is never returned', async () => {
    const raw =
      'https://raw.githubusercontent.com/acme/t/main/provelox-templates.json';
    const { templateSources, f } = setup({
      [raw]: JSON.stringify({ templates: [entry()] }),
    });
    const v = await templateSources.add({
      kind: 'git',
      url: 'https://github.com/acme/t',
      token: 'ghp_secret',
    });
    expect(f.calls[0].url).toBe(raw);
    expect(f.calls[0].headers.authorization).toBe('Bearer ghp_secret');
    expect(v).toMatchObject({
      ref: 'main',
      path: 'provelox-templates.json',
      hasToken: true,
    });
    expect(JSON.stringify(templateSources.list())).not.toContain('ghp_secret');
  });

  it('fetches a compose file kept next to the index', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({
        templates: [
          entry({ compose: undefined, composeFile: 'site/compose.yml' }),
        ],
      }),
      'https://templates.example.com/site/compose.yml': COMPOSE,
    });
    await templateSources.add({ kind: 'index', url: URL_ });
    expect(templateSources.all()[0].compose).toBe(COMPOSE);
  });

  it('refuses a registry it cannot read, or that has nothing usable, and saves nothing', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ templates: [entry({ id: 'BAD' })] }),
    });
    await expect(
      templateSources.add({ kind: 'index', url: 'https://nope.example.com/x' }),
    ).rejects.toThrow(/Could not read/);
    await expect(
      templateSources.add({ kind: 'index', url: URL_ }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(templateSources.list()).toEqual([]);
  });

  it('refuses the same registry twice', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    await templateSources.add({ kind: 'index', url: URL_ });
    await expect(
      templateSources.add({ kind: 'index', url: URL_ }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('keeps the last good templates when a refresh fails, and says why', async () => {
    const { templateSources, f } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    const v = await templateSources.add({ kind: 'index', url: URL_ });
    templateSources.fetchImpl = files({ [URL_]: 500 }).impl;
    const after = await templateSources.refresh(v.id);
    expect(after.error).toMatch(/500/);
    expect(templateSources.all()).toHaveLength(1);
    void f;
  });

  it('removes a registry and its templates', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    const v = await templateSources.add({ kind: 'index', url: URL_ });
    templateSources.remove(v.id);
    expect(templateSources.all()).toEqual([]);
  });

  it('lets a project deployed from a registry template show how to connect', async () => {
    const { templateSources, projects } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    await templateSources.add({ kind: 'index', url: URL_ });
    await projects.deploy('mysite', { compose: COMPOSE, variables: {} });
    expect((await projects.get('mysite')).template?.name).toBe('Site');
  });
});

describe('TemplateSourcesService.upsert (what a hub sends)', () => {
  const URL_ = 'https://templates.example.com/index.json';
  const setup = (map: Record<string, string | number>) => {
    const s = makeStack();
    s.templateSources.fetchImpl = files(map).impl;
    return s;
  };

  it('adds a registry it does not have, and updates one it does, keeping its token unless a new one comes', async () => {
    const { templateSources, db } = setup({
      [URL_]: JSON.stringify({ name: 'Acme', templates: [entry()] }),
    });
    const a = await templateSources.upsert({
      kind: 'index',
      url: URL_,
      token: 't1',
    });
    expect(a.hasToken).toBe(true);
    const sealed = () =>
      (
        db.raw
          .prepare('SELECT sealed_token AS t FROM template_sources')
          .get() as { t: string }
      ).t;
    const first = sealed();
    const b = await templateSources.upsert({
      kind: 'index',
      url: URL_,
      name: 'Renamed',
    });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('Renamed');
    expect(sealed()).toBe(first);
    await templateSources.upsert({ kind: 'index', url: URL_, token: 't2' });
    expect(sealed()).not.toBe(first);
    expect(templateSources.list()).toHaveLength(1);
  });

  it('refuses a registry it cannot read and leaves what it had', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    await templateSources.upsert({ kind: 'index', url: URL_ });
    templateSources.fetchImpl = files({ [URL_]: 500 }).impl;
    await expect(
      templateSources.upsert({ kind: 'index', url: URL_, name: 'X' }),
    ).rejects.toThrow(/Could not read/);
    expect(templateSources.list()[0].name).not.toBe('X');
    expect(templateSources.all()).toHaveLength(1);
  });

  it('will not turn an index into a git repository', async () => {
    const { templateSources } = setup({
      [URL_]: JSON.stringify({ templates: [entry()] }),
    });
    await templateSources.upsert({ kind: 'index', url: URL_ });
    await expect(
      templateSources.upsert({ kind: 'git', url: URL_ }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
