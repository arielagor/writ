import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Fixed clock for every test, safely before both example expiries. */
export const NOW = new Date("2026-09-08T12:00:00.000Z");

export function examplePath(name: string): string {
  return join(ROOT, "examples", `${name}.yaml`);
}

/** The manifest path as the CLI records it in the hook command: relative, forward slashes. */
export function exampleRelPath(name: string): string {
  return `examples/${name}.yaml`;
}

export function goldenPath(name: string, file: string): string {
  return join(ROOT, "test", "golden", name, file);
}

export function readGolden(name: string, file: string): string {
  return readFileSync(goldenPath(name, file), "utf8");
}

export function readExampleText(name: string): string {
  return readFileSync(examplePath(name), "utf8");
}
