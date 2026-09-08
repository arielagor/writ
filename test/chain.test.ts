import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecord,
  ChainError,
  GENESIS_HASH,
  hashArgs,
  lockPathFor,
  readChain,
  recordHash,
  verifyChain,
  type ChainRecord,
} from "../src/chain/index.js";
import { LockTimeoutError, withFileLock } from "../src/chain/lock.js";
import { ROOT } from "./helpers.js";

function freshChain(): string {
  const dir = mkdtempSync(join(tmpdir(), "remit-chain-"));
  return join(dir, "chain.jsonl");
}

function appendN(chainPath: string, n: number, extra: Record<string, unknown> = {}): ChainRecord[] {
  const out: ChainRecord[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      appendRecord(
        {
          agent_id: "blog-publisher",
          purpose_id: "agorme-blog-publish",
          policy_version: "f".repeat(64),
          tool: i % 2 === 0 ? "Edit" : "Write",
          args: { file_path: `/workspace/blog/posts/${i}.mdx`, ...extra },
          resource: `/workspace/blog/posts/${i}.mdx`,
          identity: "main",
          session_id: "s-1",
          decision: i % 3 === 0 ? "DENY" : "ALLOW",
          reason: i % 3 === 0 ? "no permit matched" : "agorme-blog-publish.Write",
        },
        { chainPath },
      ),
    );
  }
  return out;
}

function lines(chainPath: string): string[] {
  return readFileSync(chainPath, "utf8").split("\n").filter((l) => l.length > 0);
}

function rewrite(chainPath: string, ls: string[]): void {
  writeFileSync(chainPath, ls.map((l) => l + "\n").join(""), "utf8");
}

test("append N: sequential seq, genesis link, every record signed, verify ok", () => {
  const chain = freshChain();
  const recs = appendN(chain, 5);
  assert.deepEqual(recs.map((r) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(recs[0]!.prev_hash, GENESIS_HASH);
  for (let i = 1; i < recs.length; i++) assert.equal(recs[i]!.prev_hash, recs[i - 1]!.hash);
  for (const r of recs) {
    assert.equal(recordHash(r), r.hash);
    assert.ok(r.sig.length > 40);
  }
  const v = verifyChain(chain);
  assert.equal(v.ok, true, v.error ?? "");
  assert.equal(v.records, 5);
  assert.equal(v.first_bad_seq, null);
  assert.ok(existsSync(v.public_key_path));
});

test("arguments are hashed, never stored: a secret passed as an arg is absent from the file", () => {
  const chain = freshChain();
  const secret = "sk_live_THIS_MUST_NOT_APPEAR_9f8e7d";
  appendN(chain, 2, { token: secret });
  const text = readFileSync(chain, "utf8");
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("/workspace/blog/posts/1.mdx"), true, "the resource path is recorded");
});

test("hashArgs: key order does not matter, values do", () => {
  assert.equal(hashArgs({ a: 1, b: "x" }), hashArgs({ b: "x", a: 1 }));
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
  assert.equal(hashArgs(undefined), hashArgs({}));
});

test("tamper: changing one field in the middle fails verification at that seq", () => {
  const chain = freshChain();
  appendN(chain, 5);
  const ls = lines(chain);
  const rec = JSON.parse(ls[2]!) as ChainRecord;
  rec.reason = "edited after the fact";
  ls[2] = JSON.stringify(rec);
  rewrite(chain, ls);
  const v = verifyChain(chain);
  assert.equal(v.ok, false);
  assert.equal(v.first_bad_seq, 3);
  assert.match(v.error ?? "", /content does not match its hash/);
});

test("tamper: a recomputed hash without the key still fails on the signature", () => {
  const chain = freshChain();
  appendN(chain, 3);
  const ls = lines(chain);
  const rec = JSON.parse(ls[1]!) as ChainRecord;
  rec.decision = "ALLOW";
  rec.reason = "flipped";
  rec.hash = recordHash(rec);
  ls[1] = JSON.stringify(rec);
  rewrite(chain, ls);
  const v = verifyChain(chain);
  assert.equal(v.ok, false);
  assert.equal(v.first_bad_seq, 2);
  assert.match(v.error ?? "", /signature does not verify/);
});

test("tamper: deleting a middle record breaks the sequence at the next one", () => {
  const chain = freshChain();
  appendN(chain, 5);
  const ls = lines(chain);
  ls.splice(2, 1);
  rewrite(chain, ls);
  const v = verifyChain(chain);
  assert.equal(v.ok, false);
  assert.equal(v.first_bad_seq, 3);
  assert.match(v.error ?? "", /expected seq 3, found 4/);
});

test("tamper: a truncated last line fails, naming the seq that is missing", () => {
  const chain = freshChain();
  appendN(chain, 4);
  const text = readFileSync(chain, "utf8");
  const cut = text.slice(0, text.length - 40);
  writeFileSync(chain, cut, "utf8");
  const v = verifyChain(chain);
  assert.equal(v.ok, false);
  assert.equal(v.records, 3);
  assert.equal(v.first_bad_seq, 4);
  assert.match(v.error ?? "", /unparseable line/);
});

test("fail closed: appending to a chain with a damaged tail throws rather than continuing the damage", () => {
  const chain = freshChain();
  appendN(chain, 2);
  const text = readFileSync(chain, "utf8");
  writeFileSync(chain, text.slice(0, text.length - 25), "utf8");
  assert.throws(() => appendN(chain, 1), ChainError);
});

test("verify: a missing chain or a missing public key is reported, not thrown", () => {
  const chain = freshChain();
  const missing = verifyChain(chain);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /not found/);
  appendN(chain, 1);
  const noKey = verifyChain(chain, { publicKeyPath: join(chain, "..", "nope.pub") });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error ?? "", /public key unreadable/);
});

test("readChain: an empty line inside the file is reported as damage", () => {
  const chain = freshChain();
  appendN(chain, 2);
  const ls = lines(chain);
  rewrite(chain, [ls[0]!, "", ls[1]!]);
  const parsed = readChain(chain);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.badLine?.line, 2);
});

test("lock: a held lock times out for a second taker; a stale lock is swept", () => {
  const chain = freshChain();
  const lock = lockPathFor(chain);
  const fd = openSync(lock, "wx");
  assert.throws(() => withFileLock(lock, () => 1, { timeoutMs: 120, pollMs: 5 }), LockTimeoutError);
  closeSync(fd);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  const got = withFileLock(lock, () => "acquired", { timeoutMs: 120, staleMs: 30_000 });
  assert.equal(got, "acquired");
  assert.equal(existsSync(lock), false, "lock released");
});

test("lock: released even when the critical section throws", () => {
  const chain = freshChain();
  const lock = lockPathFor(chain);
  assert.throws(() => withFileLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lock), false);
});

test("concurrency: three processes appending at once produce one unbroken chain of 12", () => {
  const chain = freshChain();
  const worker = join(ROOT, "test", "fixtures", "append-worker.ts");
  const children = ["a", "b", "c"].map((label) =>
    spawn(process.execPath, ["--import", "tsx", worker, chain, "4", label], { stdio: ["ignore", "pipe", "pipe"] }),
  );
  return Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          let err = "";
          child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
        }),
    ),
  ).then(() => {
    const v = verifyChain(chain);
    assert.equal(v.ok, true, v.error ?? "");
    assert.equal(v.records, 12);
    const seqs = readChain(chain).records.map((r) => r.seq);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(existsSync(lockPathFor(chain)), false, "no lock left behind");
    rmSync(join(chain, ".."), { recursive: true, force: true });
  });
});
