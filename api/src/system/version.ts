import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The release the image was built from (PROVELOX_VERSION, set by the release workflow), else the version in the API's
 * package.json, found by walking up from here (the layout differs in dev and in the image). package.json is not the
 * release: it is not bumped when a tag is made.
 */
export const apiVersion = (() => {
  const fromImage = process.env.PROVELOX_VERSION?.trim();
  if (fromImage) return fromImage;
  try {
    let dir = __dirname;
    for (let i = 0; i < 5; i++, dir = dirname(dir)) {
      const file = join(dir, 'package.json');
      if (existsSync(file))
        return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string })
          .version;
    }
  } catch {
    // an unreadable file is not worth failing a status call for
  }
  return undefined;
})();
