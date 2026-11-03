import 'server-only';
import { z } from 'zod';
import { valueOrFile } from './env-file';

const schema = z.object({
  /** Base URL of the Provelox API as the Next.js server reaches it (not the browser) */
  PROVELOX_API_URL: z.string().url(),
  /** How CI reaches the API (shown in the workflow snippet). Defaults to PROVELOX_API_URL */
  PROVELOX_PUBLIC_API_URL: z.string().url().optional(),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 14)
    .default(8),
});

let cached: z.infer<typeof schema> | undefined;

export function env() {
  if (!cached) {
    cached = schema.parse({
      PROVELOX_API_URL: process.env.PROVELOX_API_URL?.replace(/\/+$/, ''),
      PROVELOX_PUBLIC_API_URL:
        process.env.PROVELOX_PUBLIC_API_URL?.replace(/\/+$/, '') || undefined,
      // a Docker secret arrives as a file (SESSION_SECRET_FILE)
      SESSION_SECRET: valueOrFile('SESSION_SECRET', process.env),
      SESSION_HOURS: process.env.SESSION_HOURS || undefined,
    });
  }
  return cached;
}
