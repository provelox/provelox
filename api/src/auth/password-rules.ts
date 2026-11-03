import { ValidationError } from '../common/errors';

/** bcrypt only reads the first 72 bytes; longer passwords would silently be truncated */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

/** The rules every new admin password follows, wherever it is set. */
export function assertValidNewPassword(password: string | undefined): void {
  if ((password ?? '').length < MIN_PASSWORD_LENGTH)
    throw new ValidationError(
      `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  if (Buffer.byteLength(password as string) > MAX_PASSWORD_BYTES)
    throw new ValidationError(
      `The new password can be at most ${MAX_PASSWORD_BYTES} bytes.`,
    );
}
