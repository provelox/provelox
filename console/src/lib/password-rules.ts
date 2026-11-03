// The API hashes with bcrypt, which only reads the first 72 bytes: a longer password would be silently cut
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = MAX_PASSWORD_BYTES;
