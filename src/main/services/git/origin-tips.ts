/**
 * The commit each of origin's branches is at in a clone, by its remote-tracking ref, or null for
 * a branch the clone has no copy of.
 */
export type OriginTips = ReadonlyMap<string, string | null>;

/** The `git for-each-ref` arguments that list origin's copies of `branches`. */
export function originTipsArgs(branches: readonly string[]): string[] {
  return [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    ...branches.map((branch) => `refs/remotes/origin/${branch}`),
  ];
}

/** Origin's tips of `branches` from what originTipsArgs listed, after any other output. */
export function parseOriginTips(output: string, branches: readonly string[]): OriginTips {
  const listed = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40,64}) refs\/remotes\/origin\/(.+)$/.exec(line.trim());
    if (match) listed.set(match[2], match[1]);
  }
  return new Map(branches.map((branch) => [branch, listed.get(branch) ?? null]));
}
