/**
 * Concurrency worker for the chain tests: appends N records to the chain at argv[2] and exits.
 * Several of these run at once; the lock must serialize them into one unbroken chain.
 */

import { appendRecord } from "../../src/chain/index.js";

const chainPath = process.argv[2];
const count = Number(process.argv[3] ?? "4");
const label = process.argv[4] ?? String(process.pid);
if (!chainPath) {
  process.stderr.write("usage: append-worker <chain> [count] [label]\n");
  process.exit(1);
}

for (let i = 0; i < count; i++) {
  appendRecord(
    {
      agent_id: "worker",
      purpose_id: "concurrency-test",
      policy_version: "0".repeat(64),
      tool: "noop",
      args: { worker: label, i },
      decision: i % 2 === 0 ? "ALLOW" : "DENY",
      reason: `worker ${label} record ${i}`,
    },
    { chainPath },
  );
}
process.stdout.write(`${label}:${count}\n`);
