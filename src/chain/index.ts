/**
 * The audit chain: an append-only, hash-linked, signed JSONL log of every decision.
 *
 * One record per decision. Each record carries the hash of the previous record and its own
 * hash over its canonical JSON, and an ed25519 signature over that hash. Change a byte in any
 * record, drop a record, or cut the file short, and `verifyChain` names the first sequence
 * number that no longer holds.
 *
 * Arguments are never stored. `arg_hash` is the sha256 of the canonical JSON of the tool's
 * arguments, which lets an auditor confirm "this exact call" without the chain ever holding a
 * command line, a file body, or a token.
 *
 * Every enforcement point (the Claude Code hook, the MCP proxy) imports `appendRecord` from
 * here and nothing else writes the file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { dirname } from "node:path";
import { canonicalJson } from "../manifest.js";
import { fromRoot } from "../paths.js";
import { ensureKeys, keysDirFor, loadPublicKey, publicKeyPathFor } from "./keys.js";
import { withFileLock } from "./lock.js";

export const GENESIS_HASH = "0".repeat(64);
export const DEFAULT_CHAIN_RELATIVE = "data/chain.jsonl";

export type ChainDecision = "ALLOW" | "DENY" | "ERROR";

export interface ChainRecordInput {
  agent_id: string;
  purpose_id: string;
  policy_version: string;
  tool: string;
  /** The tool's raw arguments. Hashed; never written. */
  args?: unknown;
  /** Set when the caller already hashed the arguments (or when they are unavailable). */
  arg_hash?: string;
  /** The resource the call targets (a normalized path or the tool name). Not a secret; not the args. */
  resource?: string | null;
  /** Credential minted for this call by the broker, if any. */
  credential_id?: string | null;
  /** Harness-supplied identity of the caller (agent type or name), for attribution. */
  identity?: string | null;
  session_id?: string | null;
  decision: ChainDecision;
  reason: string;
}

export interface ChainRecord {
  seq: number;
  ts: string;
  agent_id: string;
  purpose_id: string;
  policy_version: string;
  tool: string;
  resource: string | null;
  arg_hash: string;
  credential_id: string | null;
  identity: string | null;
  session_id: string | null;
  decision: ChainDecision;
  reason: string;
  prev_hash: string;
  hash: string;
  sig: string;
}

export interface AppendOptions {
  /** Chain file. Defaults to `REMIT_CHAIN` or `<repo>/data/chain.jsonl`. */
  chainPath?: string;
  /** The clock. Defaults to the real clock. */
  now?: Date;
}

export interface VerifyResult {
  ok: boolean;
  chain_path: string;
  public_key_path: string;
  records: number;
  /** Sequence number at which the chain first fails, or null when it holds. */
  first_bad_seq: number | null;
  error: string | null;
}

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

const DECISIONS: ReadonlySet<string> = new Set(["ALLOW", "DENY", "ERROR"]);
const HEX64 = /^[0-9a-f]{64}$/;

export function resolveChainPath(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env["REMIT_CHAIN"];
  if (env && env.length > 0) return env;
  return fromRoot(DEFAULT_CHAIN_RELATIVE);
}

export function lockPathFor(chainPath: string): string {
  return `${chainPath}.lock`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 of the canonical JSON of the arguments. Key order does not matter; values do. */
export function hashArgs(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? {}));
}

type Unsigned = Omit<ChainRecord, "hash" | "sig">;

/** The record's hash: sha256 over its canonical JSON with `hash` and `sig` removed. */
export function recordHash(record: Omit<ChainRecord, "hash" | "sig"> | ChainRecord): string {
  const { hash: _h, sig: _s, ...rest } = record as ChainRecord;
  return sha256Hex(canonicalJson(rest));
}

function signHash(hash: string, privateKey: KeyObject): string {
  return edSign(null, Buffer.from(hash, "hex"), privateKey).toString("base64");
}

function verifySig(hash: string, sig: string, publicKey: KeyObject): boolean {
  try {
    return edVerify(null, Buffer.from(hash, "hex"), publicKey, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

interface ParsedChain {
  records: ChainRecord[];
  /** Set when a line could not be parsed; parsing stops there. */
  badLine: { line: number; message: string } | null;
}

/** Read every record. A malformed line stops the read and is reported, not skipped. */
export function readChain(chainPath: string): ParsedChain {
  if (!existsSync(chainPath)) return { records: [], badLine: null };
  const text = readFileSync(chainPath, "utf8");
  const records: ChainRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length === 0) {
      if (i === lines.length - 1) break;
      return { records, badLine: { line: i + 1, message: "empty line inside the chain" } };
    }
    try {
      records.push(JSON.parse(line) as ChainRecord);
    } catch (e) {
      return { records, badLine: { line: i + 1, message: `unparseable line: ${(e as Error).message}` } };
    }
  }
  return { records, badLine: null };
}

function tail(chainPath: string): { last: ChainRecord | null; count: number } {
  const parsed = readChain(chainPath);
  if (parsed.badLine) {
    throw new ChainError(`chain tail is damaged at line ${parsed.badLine.line}: ${parsed.badLine.message}; refusing to append`);
  }
  const last = parsed.records.length > 0 ? parsed.records[parsed.records.length - 1]! : null;
  return { last, count: parsed.records.length };
}

/**
 * Append one signed record. Takes the chain lock, reads the tail, links, hashes, signs, and
 * writes the line in a single append. Throws ChainError when the existing tail is damaged.
 */
export function appendRecord(input: ChainRecordInput, opts: AppendOptions = {}): ChainRecord {
  if (!DECISIONS.has(input.decision)) throw new ChainError(`invalid decision ${JSON.stringify(input.decision)}`);
  const chainPath = resolveChainPath(opts.chainPath);
  mkdirSync(dirname(chainPath), { recursive: true });

  return withFileLock(lockPathFor(chainPath), () => {
    const keys = ensureKeys(keysDirFor(chainPath));
    const { last, count } = tail(chainPath);
    const unsigned: Unsigned = {
      seq: count + 1,
      ts: (opts.now ?? new Date()).toISOString(),
      agent_id: input.agent_id,
      purpose_id: input.purpose_id,
      policy_version: input.policy_version,
      tool: input.tool,
      resource: input.resource ?? null,
      arg_hash: input.arg_hash ?? hashArgs(input.args),
      credential_id: input.credential_id ?? null,
      identity: input.identity ?? null,
      session_id: input.session_id ?? null,
      decision: input.decision,
      reason: input.reason,
      prev_hash: last ? last.hash : GENESIS_HASH,
    };
    const hash = recordHash(unsigned);
    const record: ChainRecord = { ...unsigned, hash, sig: signHash(hash, keys.privateKey) };
    appendFileSync(chainPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    return record;
  });
}

export interface VerifyOptions {
  publicKeyPath?: string;
}

/** Walk the chain and check sequence, links, hashes, and signatures. Never throws on a bad chain. */
export function verifyChain(chainPath: string, opts: VerifyOptions = {}): VerifyResult {
  const publicKeyPath = opts.publicKeyPath ?? publicKeyPathFor(chainPath);
  const base = { chain_path: chainPath, public_key_path: publicKeyPath };

  if (!existsSync(chainPath)) {
    return { ok: false, ...base, records: 0, first_bad_seq: null, error: `chain file not found: ${chainPath}` };
  }
  let publicKey: KeyObject;
  try {
    publicKey = loadPublicKey(publicKeyPath);
  } catch (e) {
    return { ok: false, ...base, records: 0, first_bad_seq: null, error: `public key unreadable: ${(e as Error).message}` };
  }

  const parsed = readChain(chainPath);
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const rec of parsed.records) {
    const bad = (error: string): VerifyResult => ({ ok: false, ...base, records: parsed.records.length, first_bad_seq: expectedSeq, error });
    if (typeof rec !== "object" || rec === null) return bad("record is not an object");
    if (rec.seq !== expectedSeq) return bad(`expected seq ${expectedSeq}, found ${String(rec.seq)}`);
    if (!DECISIONS.has(rec.decision)) return bad(`seq ${rec.seq}: invalid decision ${JSON.stringify(rec.decision)}`);
    if (rec.prev_hash !== prevHash) return bad(`seq ${rec.seq}: prev_hash does not match the previous record`);
    if (typeof rec.hash !== "string" || !HEX64.test(rec.hash)) return bad(`seq ${rec.seq}: malformed hash`);
    if (recordHash(rec) !== rec.hash) return bad(`seq ${rec.seq}: content does not match its hash`);
    if (typeof rec.sig !== "string" || !verifySig(rec.hash, rec.sig, publicKey)) return bad(`seq ${rec.seq}: signature does not verify`);
    prevHash = rec.hash;
    expectedSeq++;
  }
  if (parsed.badLine) {
    return { ok: false, ...base, records: parsed.records.length, first_bad_seq: expectedSeq, error: `line ${parsed.badLine.line}: ${parsed.badLine.message}` };
  }
  return { ok: true, ...base, records: parsed.records.length, first_bad_seq: null, error: null };
}

export { keysDirFor, publicKeyPathFor };
