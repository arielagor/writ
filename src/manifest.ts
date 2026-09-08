/**
 * Purpose manifest: load, validate, apply defaults, and version.
 *
 * The manifest is the source of truth. Everything else in Remit is compiled from it.
 * Validation is two layers: the JSON Schema (shape, patterns, ranges, the deny_by_default
 * literal) and semantic checks the schema cannot express (regexes compile, the expiry is in
 * the future, tool names are unique).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type ArgRule = string | string[];

export interface ToolConstraints {
  arg_allow?: Record<string, ArgRule>;
  arg_deny?: Record<string, ArgRule>;
  path_prefixes?: string[];
}

export interface AllowedTool {
  name: string;
  constraints?: ToolConstraints;
}

export interface PurposeManifest {
  agent_id: string;
  owner: { name: string; email: string };
  purpose: string;
  purpose_id: string;
  allowed_tools: AllowedTool[];
  data_classes: string[];
  credential_ttl_seconds: number;
  expires_at: string;
  escalation_contact: string;
  deny_by_default: true;
}

export interface ValidateOptions {
  /** The clock used for the expiry check. Defaults to the real clock. */
  now?: Date;
}

export type ValidationResult =
  | { ok: true; manifest: PurposeManifest; errors: [] }
  | { ok: false; errors: string[] };

export class ManifestError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid purpose manifest:\n  - ${errors.join("\n  - ")}`);
    this.name = "ManifestError";
    this.errors = errors;
  }
}

const SCHEMA_PATH = fileURLToPath(new URL("../schema/manifest.schema.json", import.meta.url));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (compiled) return compiled;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: true });
  ajv.addFormat("email", (s: string) => EMAIL.test(s));
  ajv.addFormat("date-time", (s: string) => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)));
  const fn = ajv.compile(schema);
  compiled = fn;
  return fn;
}

function describe(err: ErrorObject): string {
  const where = err.instancePath === "" ? "/" : err.instancePath;
  const extra =
    err.keyword === "additionalProperties" && typeof err.params["additionalProperty"] === "string"
      ? ` (${String(err.params["additionalProperty"])})`
      : "";
  return `${where}: ${err.message ?? err.keyword}${extra}`;
}

function checkRegex(source: string, at: string, errors: string[]): void {
  try {
    new RegExp(source);
  } catch (e) {
    errors.push(`${at}: invalid regular expression ${JSON.stringify(source)}: ${(e as Error).message}`);
  }
}

function semanticChecks(m: PurposeManifest, now: Date): string[] {
  const errors: string[] = [];

  const expires = Date.parse(m.expires_at);
  if (Number.isNaN(expires)) {
    errors.push(`/expires_at: not a parseable date-time: ${JSON.stringify(m.expires_at)}`);
  } else if (expires <= now.getTime()) {
    errors.push(`/expires_at: manifest expired at ${m.expires_at} (now ${now.toISOString()})`);
  }

  const seen = new Set<string>();
  m.allowed_tools.forEach((tool, i) => {
    const at = `/allowed_tools/${i}`;
    if (seen.has(tool.name)) errors.push(`${at}/name: duplicate tool ${JSON.stringify(tool.name)}`);
    seen.add(tool.name);
    const c = tool.constraints;
    if (!c) return;
    for (const kind of ["arg_allow", "arg_deny"] as const) {
      const rules = c[kind];
      if (!rules) continue;
      for (const [key, rule] of Object.entries(rules)) {
        if (typeof rule === "string") checkRegex(rule, `${at}/constraints/${kind}/${key}`, errors);
      }
    }
    if (c.path_prefixes) {
      c.path_prefixes.forEach((p, j) => {
        if (p.includes("\\")) {
          errors.push(`${at}/constraints/path_prefixes/${j}: use forward slashes, not backslashes`);
        }
      });
    }
  });

  return errors;
}

/** Validate an already-parsed object. Applies defaults on success. Never throws. */
export function validateManifest(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const now = opts.now ?? new Date();
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["/: manifest must be a mapping"] };
  }
  const candidate = structuredClone(input) as Record<string, unknown>;
  const validate = validator();
  if (!validate(candidate)) {
    const errs = (validate.errors ?? []).map(describe);
    return { ok: false, errors: errs.length > 0 ? errs : ["/: schema validation failed"] };
  }
  const manifest = candidate as unknown as PurposeManifest;
  const errors = semanticChecks(manifest, now);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest, errors: [] };
}

/** Parse YAML (or JSON, which is YAML) and validate. Throws ManifestError. */
export function parseManifest(text: string, opts: ValidateOptions = {}): PurposeManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new ManifestError([`/: YAML parse error: ${(e as Error).message}`]);
  }
  const result = validateManifest(parsed, opts);
  if (!result.ok) throw new ManifestError(result.errors);
  return result.manifest;
}

/** Read a manifest file and validate it. Throws ManifestError. */
export function loadManifest(path: string, opts: ValidateOptions = {}): PurposeManifest {
  return parseManifest(readFileSync(path, "utf8"), opts);
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The policy version: sha256 of the canonical JSON of the validated manifest.
 * Reformatting the YAML does not change it. Changing any rule does.
 */
export function manifestVersion(m: PurposeManifest): string {
  return createHash("sha256").update(canonicalJson(m)).digest("hex");
}

/** Normalize a path for comparison: forward slashes, no trailing duplicates. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
