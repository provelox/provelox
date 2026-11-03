import type { PeerCertificate } from 'node:tls';
import { makeStack } from '../test-utils';
import { NotificationsService } from './notifications.service';

async function setup() {
  const s = makeStack();
  const notifications = new NotificationsService(s.settings, s.apps, s.cfg);
  const sent: { url: string; body: any }[] = [];
  let respond: { ok: boolean; status: number } | Error = {
    ok: true,
    status: 200,
  };
  notifications.fetcher = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (respond instanceof Error) throw respond;
    return respond;
  };
  await s.apps.create({ name: 'site' });
  await s.apps.deploy('site', 'acme/site:1');
  return {
    ...s,
    notifications,
    sent,
    failWith: (r: { ok: boolean; status: number } | Error) => (respond = r),
    // make the fake Docker report the app as failing, or well
    setState: (state: 'failed' | 'running') =>
      (s.docker.statusOverride = () => ({
        desired: 1,
        running: state === 'running' ? 1 : 0,
        state,
        image: 'acme/site:1',
      })),
  };
}

const HOOK = 'https://hooks.example.com/services/T000/SECRET-TOKEN';

describe('webhooks', () => {
  it('are shown by host only, and the address is kept sealed', async () => {
    const { notifications, settings } = await setup();
    const w = notifications.addWebhook('Team chat', HOOK);
    expect(w).toMatchObject({ name: 'Team chat', host: 'hooks.example.com' });
    expect(JSON.stringify(notifications.view())).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(settings.get('notifications'))).not.toContain(
      'SECRET-TOKEN',
    );
  });

  it('refuse a name that is empty, an address that is not one, and a scheme that is not web', async () => {
    const { notifications } = await setup();
    expect(() => notifications.addWebhook(' ', HOOK)).toThrow(/name/);
    expect(() => notifications.addWebhook('x', 'nope')).toThrow(/address/);
    expect(() => notifications.addWebhook('x', 'ftp://h/x')).toThrow(/https/);
  });

  it('can be removed, and a test message says how it went', async () => {
    const { notifications, sent, failWith } = await setup();
    const w = notifications.addWebhook('Chat', HOOK);
    expect(await notifications.test(w.id)).toMatchObject({
      ok: true,
      status: 'Delivered (200)',
    });
    expect(sent[0].url).toBe(HOOK);
    expect(sent[0].body).toMatchObject({ event: 'test', source: 'provelox' });
    failWith({ ok: false, status: 404 });
    expect((await notifications.test(w.id)).status).toBe('Refused (404)');
    failWith(new Error('connection refused'));
    expect((await notifications.test(w.id)).status).toMatch(
      /Could not reach it: connection refused/,
    );
    expect(notifications.view().webhooks[0].lastStatus).toMatch(
      /Could not reach it/,
    );
    notifications.removeWebhook(w.id);
    expect(notifications.view().webhooks).toEqual([]);
    expect(() => notifications.removeWebhook(w.id)).toThrow(/no such webhook/);
  });
});

describe('sync (what a hub sends)', () => {
  it('adds webhooks by name, replaces the address of one with the same name, and leaves the others', async () => {
    const { notifications } = await setup();
    notifications.addWebhook('Own', 'https://own.example.com/x');
    notifications.sync({
      webhooks: [
        { name: 'Team', url: 'https://hooks.example.com/a' },
        { name: 'Own', url: 'https://moved.example.com/y' },
      ],
    });
    const v = notifications.view();
    expect(v.webhooks.map((w) => [w.name, w.host]).sort()).toEqual([
      ['Own', 'moved.example.com'],
      ['Team', 'hooks.example.com'],
    ]);
    // again: the same names, so none are added
    notifications.sync({
      webhooks: [{ name: 'Team', url: 'https://hooks.example.com/a' }],
    });
    expect(notifications.view().webhooks).toHaveLength(2);
  });

  it('sets only the events it is given, and refuses a bad address', async () => {
    const { notifications } = await setup();
    notifications.sync({ events: { certificate: false } });
    expect(notifications.view().events).toEqual({
      problem: true,
      recovered: true,
      certificate: false,
    });
    expect(() =>
      notifications.sync({ webhooks: [{ name: 'x', url: 'not a url' }] }),
    ).toThrow();
    expect(() =>
      notifications.sync({
        webhooks: [{ name: ' ', url: 'https://a.example.com' }],
      }),
    ).toThrow();
  });
});

describe('watching apps', () => {
  it('reports a failing app once it has lasted, in the shapes Slack and Discord read, then reports the recovery', async () => {
    const { notifications, sent, setState } = await setup();
    notifications.addWebhook('Chat', HOOK);
    setState('failed');
    await notifications.check(1);
    expect(sent).toHaveLength(0); // one bad check is a blip
    await notifications.check(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({
      event: 'problem',
      app: 'site',
      title: 'site is failing',
    });
    expect(sent[0].body.text).toContain('site is failing');
    expect(sent[0].body.content).toContain('**site is failing**');
    await notifications.check(3);
    expect(sent).toHaveLength(1); // not again while it stays bad
    setState('running');
    await notifications.check(4);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatchObject({
      event: 'recovered',
      title: 'site is back',
    });
  });

  it('sends nothing for events that are switched off', async () => {
    const { notifications, sent, setState } = await setup();
    notifications.addWebhook('Chat', HOOK);
    notifications.setEvents({ problem: false });
    setState('failed');
    await notifications.check(1);
    await notifications.check(2);
    expect(sent).toHaveLength(0);
  });

  it('says nothing for an app stopped on purpose', async () => {
    const { notifications, sent, apps } = await setup();
    notifications.addWebhook('Chat', HOOK);
    await apps.update('site', { instanceCount: 0 });
    await notifications.check(1);
    await notifications.check(2);
    expect(sent).toHaveLength(0);
  });
});

describe('watching certificates', () => {
  const cert = (days: number, host: string) =>
    ({
      subject: { CN: host },
      issuer: { O: "Let's Encrypt" },
      subjectaltname: `DNS:${host}`,
      valid_to: new Date(Date.now() + days * 86_400_000).toUTCString(),
    }) as unknown as PeerCertificate;

  it('reports one that is running out, once, and again only after a renewal', async () => {
    const { notifications, sent, apps } = await setup();
    notifications.addWebhook('Chat', HOOK);
    await apps.update('site', { defaultSubdomainSsl: true });
    let days = 60;
    apps.tlsProbe = async (h) => cert(days, h);
    const hour = 3_600_000 + 1;
    await notifications.check(hour);
    expect(sent.filter((x) => x.body.event === 'certificate')).toHaveLength(0);
    days = 9;
    await notifications.check(hour * 3);
    const certs = () => sent.filter((x) => x.body.event === 'certificate');
    expect(certs()).toHaveLength(1);
    expect(certs()[0].body).toMatchObject({ host: 'site.example.com' });
    expect(certs()[0].body.title).toMatch(/expires soon/);
    await notifications.check(hour * 5);
    expect(certs()).toHaveLength(1);
    days = 80; // renewed
    await notifications.check(hour * 7);
    days = 5; // running out again
    await notifications.check(hour * 9);
    expect(certs()).toHaveLength(2);
  });
});
