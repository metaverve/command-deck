#!/usr/bin/env node
// Reads a password from stdin and prints a CC_PASSWORD_HASH value. The password is never printed.
// Usage:  printf %s "$CC_PASSWORD" | node scripts/hash-password.mjs
//    or:  node scripts/hash-password.mjs   (then type the password and press Ctrl-D)
import { webcrypto as crypto } from "node:crypto";
const ITER = 210000;
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const pw = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (!pw) { console.error("No password on stdin."); process.exit(1); }
if (pw.length < 8) console.error("Warning: password is shorter than 8 characters.");
const b64u = (b) => Buffer.from(b).toString("base64url");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
process.stdout.write(`pbkdf2$sha256$${ITER}$${b64u(salt)}$${b64u(bits)}\n`);
