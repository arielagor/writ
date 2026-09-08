/**
 * The chain's signing key.
 *
 * ed25519, generated on first use, stored as PEM next to the chain under `keys/`. The private
 * key never leaves the machine that writes the chain; the public key is what an auditor gets
 * with the evidence export. Generation happens under the chain lock (see `appendRecord`) so two
 * first-time writers cannot each mint a different key.
 *
 * The key directory is under `data/`, which is gitignored, and the private file is written
 * with mode 0600 where the platform honors it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { dirname, join } from "node:path";

export const PRIVATE_KEY_FILE = "chain.ed25519";
export const PUBLIC_KEY_FILE = "chain.pub";

export interface ChainKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateKeyPath: string;
  publicKeyPath: string;
}

/** Keys live in `keys/` beside the chain file. */
export function keysDirFor(chainPath: string): string {
  return join(dirname(chainPath), "keys");
}

export function publicKeyPathFor(chainPath: string): string {
  return join(keysDirFor(chainPath), PUBLIC_KEY_FILE);
}

/** Load the key pair, generating it if absent. Call only while holding the chain lock. */
export function ensureKeys(keysDir: string): ChainKeys {
  const privateKeyPath = join(keysDir, PRIVATE_KEY_FILE);
  const publicKeyPath = join(keysDir, PUBLIC_KEY_FILE);
  if (!existsSync(privateKeyPath)) {
    mkdirSync(keysDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  } else if (!existsSync(publicKeyPath)) {
    const privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
    writeFileSync(publicKeyPath, createPublicKey(privateKey).export({ type: "spki", format: "pem" }), { mode: 0o644 });
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
  const publicKey = createPublicKey(readFileSync(publicKeyPath, "utf8"));
  return { privateKey, publicKey, privateKeyPath, publicKeyPath };
}

export function loadPublicKey(publicKeyPath: string): KeyObject {
  return createPublicKey(readFileSync(publicKeyPath, "utf8"));
}
