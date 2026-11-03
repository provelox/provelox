/**
 * Where to go after signing in, from the `next` the login page was given. Only a page inside the console's own apps
 * area is accepted, so a link cannot send someone to another site (or to `//other.example`), and only ever to a page
 * to look at: never to an address that does something when it is opened.
 */
export function afterLogin(next: unknown): string {
  if (typeof next !== 'string') return '/apps';
  if (
    !/^\/apps\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_.-]{1,40}){0,2}\/?$/.test(
      next,
    )
  )
    return '/apps';
  return next;
}

/** The login address that comes back to `next` once signed in. */
export const loginUrl = (next: string) =>
  `/login?next=${encodeURIComponent(next)}`;
