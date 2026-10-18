import { createHash } from 'node:crypto';

const VERSION_LENGTH = 10;
const QUOTED_SITE_PATH = /"((?:https:\/\/tempo-match\.hadalin\.me)?)(\/[^"?#]*)"/g;

export function contentVersion(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, VERSION_LENGTH);
}

/** Appends ?v=<version> to quoted site-relative or same-origin URLs whose path has a known version. */
export function versionUrls(html: string, versions: ReadonlyMap<string, string>): string {
  return html.replace(QUOTED_SITE_PATH, (quoted, origin: string, path: string) => {
    const version = versions.get(path);
    if (version === undefined) {
      return quoted;
    }
    return `"${origin}${path}?v=${version}"`;
  });
}
