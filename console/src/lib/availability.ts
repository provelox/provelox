import { BackendError } from './backend';

/**
 * Whether a failure just means the API is not answering right now: it could not be reached at all (status 0), or the
 * proxy in front of it answered for it (502, 503, 504). That is what an update or a restart looks like from here, and it
 * passes, so the console waits instead of showing an error.
 */
export function isApiDown(e: unknown): boolean {
  return (
    e instanceof BackendError &&
    (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)
  );
}
