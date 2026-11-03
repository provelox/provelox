/** Browser-side read helper for polling. Mutations are Server Actions, not fetches. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`/api/${path}`);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const json = (await res.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}
