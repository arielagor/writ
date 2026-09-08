#!/usr/bin/env node
// Redact a private governance gate log into a publishable evidence sample.
//
// The gate log is the evidence behind the claim that these hooks actually block things.
// It is also a record of one person's machine: absolute paths, project names, shell
// commands, and the names of environment variables that hold live credentials. This
// script keeps the evidence and drops the machine.
//
// Kept:     ts, event, rule, tool, identity, decision, gate
// Shaped:   path (placeholder that preserves depth and extension), command (rule name
//           plus a short safe head), error (class only)
// Dropped:  everything else, including secrets, detail, prompt, cwd, repo, session,
//           subject, artifacts, evidence, objective, cmd
//
// Usage: node redact-gate-log.mjs <log-dir> <out.jsonl>

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [logDir, outFile] = process.argv.slice(2);
if (!logDir || !outFile) {
  console.error('usage: node redact-gate-log.mjs <log-dir> <out.jsonl>');
  process.exit(1);
}

const KEEP = ['ts', 'event', 'rule', 'tool', 'identity', 'decision', 'gate'];

// Four gates wrote this log over three months and two of them use a different shape:
// an older one writes {event: "BLOCK"|"ASK"|"PASS"}, a newer one writes
// {decision: "deny"|"allow"|"bypass"}. Normalizing to one `outcome` field is what makes
// the sample countable by a reader who did not write either gate.
function outcomeOf(rec) {
  const d = String(rec.decision ?? '').toLowerCase();
  const e = String(rec.event ?? '');
  if (d === 'deny' || e === 'BLOCK') return 'DENIED';
  if (e === 'ASK') return 'ASKED';
  if (d === 'allow' || e === 'PASS') return 'ALLOWED';
  if (d === 'bypass' || e === 'BYPASS' || e === 'ADMIN-BYPASS') return 'BYPASSED';
  if (e === 'GATE-ERROR' || e === 'SELFTEST-FAIL') return 'GATE-ERROR';
  return 'OTHER';
}

// Anything matching these must be zero in the output. Checked after redaction.
const FORBIDDEN = [
  /sk_live[-_a-z0-9]*/i,
  /sk_v2[-_a-z0-9]*/i,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /\bariel\b/i,
  /users\//i,
  /C:[\\/]/i,
];

const ENV_NAMES = [
  'NETLIFY_ACCESS_TOKEN', 'EXPO_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_AI_API_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY',
  'XAI_API_KEY', 'ELEVENLABS_API_KEY', 'HEYGEN_API_KEY', 'DUB_API_KEY',
  'TWITTER_CONSUMER_KEY', 'TWITTER_CONSUMER_SECRET', 'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_SECRET', 'FACEBOOK_APP_SECRET', 'FACEBOOK_PAGE_TOKEN_AGOR',
  'FACEBOOK_PAGE_TOKEN_MODELSTACK', 'LINKEDIN_ACCESS_TOKEN', 'SMTP_PASS',
  'GEMINI_API_KEY_FALLBACK', 'ANTHROPIC_API_KEY',
];

// A path becomes a placeholder that preserves what the rule was reacting to: how deep it
// was, and what kind of file it was. Sensitive basenames are named by CLASS, not by name,
// because "this rule fired on a signing key" is the evidence and the filename is not.
function shapePath(p) {
  if (typeof p !== 'string' || !p) return undefined;
  const lower = p.toLowerCase();
  const depth = Math.min(lower.split(/[\\/]+/).filter(Boolean).length, 6);
  const ext = (lower.match(/\.([a-z0-9]{1,6})$/) || [])[1];

  let cls = 'file';
  if (/\.(p12|p8|pem|key|keystore|jks)$/.test(lower)) cls = 'signing-key';
  else if (/service-account|credentials?\.json|gplay/.test(lower)) cls = 'service-account';
  else if (/kill-switch|never-class|governance/.test(lower)) cls = 'governance-control';
  else if (/\.env/.test(lower)) cls = 'env-file';
  else if (/hooks?[\\/]/.test(lower)) cls = 'hook-source';
  else if (ext) cls = `source.${ext}`;

  return `<${cls} depth=${depth}>`;
}

// A command is reduced to its verb and the rule that caught it. The raw command line can
// carry paths, hostnames and occasionally an inline secret, so it never survives.
function shapeCommand(c) {
  if (typeof c !== 'string' || !c) return undefined;
  const verb = (c.trim().match(/^[a-z0-9_.-]+/i) || ['?'])[0].slice(0, 24);
  return `<command verb=${verb} len=${c.length}>`;
}

const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
const out = [];
const counts = {};
const byGate = {};
let parsed = 0;
let skipped = 0;

for (const f of files) {
  for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    parsed++;
    const clean = { ts: rec.ts, outcome: outcomeOf(rec) };
    for (const k of KEEP) if (k !== 'ts' && rec[k] !== undefined) clean[k] = rec[k];
    const p = shapePath(rec.path);
    if (p) clean.path = p;
    const c = shapeCommand(rec.command ?? rec.cmd);
    if (c) clean.command = c;
    if (rec.error) clean.error = 'redacted-error';
    counts[clean.outcome] = (counts[clean.outcome] || 0) + 1;
    byGate[clean.gate || '(unlabelled)'] = (byGate[clean.gate || '(unlabelled)'] || 0) + 1;
    out.push(clean);
  }
}

const body = out.map((r) => JSON.stringify(r)).join('\n') + '\n';

// Fail closed. If any forbidden pattern survives, write nothing.
const violations = [];
for (const re of FORBIDDEN) {
  const m = body.match(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'));
  if (m) violations.push(`${re} x${m.length} (e.g. ${JSON.stringify(m[0].slice(0, 40))})`);
}
for (const name of ENV_NAMES) {
  if (body.includes(name)) violations.push(`env var name leaked: ${name}`);
}

if (violations.length) {
  console.error('REDACTION FAILED, nothing written:');
  for (const v of violations) console.error('  ' + v);
  process.exit(2);
}

writeFileSync(outFile, body);
console.error(`wrote ${out.length} records to ${outFile} (parsed ${parsed}, unparsed ${skipped})`);
console.error('outcomes: ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
console.error('gates:    ' + Object.entries(byGate).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
