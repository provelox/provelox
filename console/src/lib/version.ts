/** "0.2.5" as "v0.2.5"; names such as "edge" and "dev" stay as they are; nothing known as "version unknown". */
export function formatVersion(version: string | null | undefined): string {
  if (!version) return 'version unknown';
  return /^\d/.test(version) ? `v${version}` : version;
}
