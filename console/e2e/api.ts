/**
 * Straight to the Provelox API, only to tidy up: whatever a test creates is removed afterwards, even when the test
 * failed half way. Only apps named e2e-* are ever touched.
 */
const API = (
  process.env.E2E_API_URL ?? 'http://api.provelox.localhost'
).replace(/\/+$/, '');

async function token() {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.E2E_PASSWORD }),
  });
  if (!res.ok)
    throw new Error(`Could not sign in to ${API} to clean up (${res.status}).`);
  return ((await res.json()) as { token: string }).token;
}

/** Empty apps for a test that needs something in the list. Remove them with removeThrowawayApps. */
export async function createThrowawayApps(...names: string[]) {
  const auth = {
    authorization: `Bearer ${await token()}`,
    'content-type': 'application/json',
  };
  for (const name of names) {
    const res = await fetch(`${API}/v1/apps`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 409)
      throw new Error(`Could not create ${name} (${res.status}).`);
  }
}

export async function removeThrowawayApps() {
  const auth = { authorization: `Bearer ${await token()}` };
  const list = (await (
    await fetch(`${API}/v1/apps`, { headers: auth })
  ).json()) as {
    app: { name: string };
  }[];
  for (const { app } of list)
    if (app.name.startsWith('e2e-'))
      await fetch(`${API}/v1/apps/${app.name}`, {
        method: 'DELETE',
        headers: auth,
      });
}

/** Webhooks a test added are removed too: only those named e2e-*. */
export async function removeThrowawayWebhooks() {
  const auth = { authorization: `Bearer ${await token()}` };
  const res = await fetch(`${API}/v1/system/notifications`, { headers: auth });
  const { webhooks } = (await res.json()) as {
    webhooks: { id: string; name: string }[];
  };
  for (const w of webhooks)
    if (w.name.startsWith('e2e-'))
      await fetch(`${API}/v1/system/notifications/webhooks/${w.id}`, {
        method: 'DELETE',
        headers: auth,
      });
}
