export const SDK_VERSION = "0.1.0" as const;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Semver subset used for the catalog compatibility window. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`invalid SDK version: ${!a ? left : right}`);
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function versionIsSupported(version: string, minimum: string, maximum?: string): boolean {
  return compareVersions(version, minimum) >= 0 && (!maximum || compareVersions(version, maximum) <= 0);
}
