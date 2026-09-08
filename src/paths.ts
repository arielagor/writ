/**
 * Repository-relative paths that survive both `tsx` on `src/` and a built `dist/`.
 *
 * `import.meta.url` sits at `src/paths.ts` in development and at `dist/src/paths.js` after
 * `npm run build`, so a fixed `../` count is wrong in one of the two. Walking up to the
 * directory that holds this package's `package.json` is right in both.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "remit-agent";

let cachedRoot: string | undefined;

/** Absolute path of the repository root (the directory holding this package's package.json). */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === PACKAGE_NAME) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // not ours; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the ${PACKAGE_NAME} repository root from ${import.meta.url}`);
}

/** Resolve a path relative to the repository root. Absolute inputs are returned as is. */
export function fromRoot(...segments: string[]): string {
  return resolve(repoRoot(), ...segments);
}

/** Forward slashes, for logs and JSON that should read the same on every platform. */
export function posixPath(p: string): string {
  return p.replace(/\\/g, "/");
}
