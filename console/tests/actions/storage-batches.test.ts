import { beforeEach, describe, expect, it, vi } from 'vitest';

// The server-only pieces are replaced: the action only needs the backend call and the session.
const api = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/session', () => ({
  getSession: async () => ({ token: 'test-token' }),
  destroySession: vi.fn(),
}));
vi.mock('@/lib/backend', () => {
  class BackendError extends Error {
    isAuthFailure = false;
  }
  return { api: (...args: unknown[]) => api(...args), BackendError };
});

const { deleteVolumesAction, deleteImagesAction } =
  await import('@/actions/storage');

const names = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(
    async (
      _path: string,
      opts: { body: { names?: string[]; imageIds?: string[] } },
    ) => {
      const sent = opts.body.names ?? opts.body.imageIds ?? [];
      return { deleted: sent, skipped: [] };
    },
  );
});

describe('deleteVolumesAction batches', () => {
  it('sends at most 500 names per request and removes all of them', async () => {
    const all = names(3986);
    const res = await deleteVolumesAction(all, false);

    expect(res.ok).toBe(true);
    const calls = api.mock.calls.map((c) => c[1].body.names.length);
    expect(calls).toEqual([500, 500, 500, 500, 500, 500, 500, 486]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(500);
    if (res.ok) {
      expect(res.data).toHaveLength(3986);
      expect(res.data?.every((r) => r.removed)).toBe(true);
    }
  });

  it('passes the acknowledgement on every batch', async () => {
    await deleteVolumesAction(names(501), true);
    for (const c of api.mock.calls)
      expect(c[1].body.acknowledgeUnknownOwner).toBe(true);
  });

  it('a single batch is one request', async () => {
    const res = await deleteVolumesAction(names(12), false);
    expect(res.ok).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('reports how many were removed before a failing batch', async () => {
    api
      .mockImplementationOnce(
        async (_p: string, o: { body: { names: string[] } }) => ({
          deleted: o.body.names,
          skipped: [],
        }),
      )
      .mockRejectedValueOnce(new Error('daemon unavailable'));
    const res = await deleteVolumesAction(names(900), false);
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error).toBe(
        'Removed 500 before this failed: daemon unavailable',
      );
  });

  it('keeps skipped volumes from every batch', async () => {
    api.mockImplementation(
      async (_p: string, o: { body: { names: string[] } }) => ({
        deleted: o.body.names.slice(1),
        skipped: [{ id: o.body.names[0], reason: 'in use' }],
      }),
    );
    const res = await deleteVolumesAction(names(501), false);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const skipped = res.data?.filter((r) => !r.removed) ?? [];
      expect(skipped).toHaveLength(2);
      expect(skipped[0]).toMatchObject({ name: 'v0', reason: 'in use' });
    }
  });

  it('rejects an empty list without calling the API', async () => {
    const res = await deleteVolumesAction([], false);
    expect(res.ok).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('deleteImagesAction batches', () => {
  it('batches image ids and keeps the keep-versions setting on each request', async () => {
    const ids = names(1200);
    const res = await deleteImagesAction(ids, 2, false);
    expect(res.ok).toBe(true);
    const sizes = api.mock.calls.map((c) => c[1].body.imageIds.length);
    expect(sizes).toEqual([500, 500, 200]);
    for (const c of api.mock.calls) expect(c[1].body.keepVersions).toBe(2);
  });
});
