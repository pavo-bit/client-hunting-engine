// AUTH-001 operator provisioning (local, interactive).
// Generates a scrypt password hash for .env. The password is read from stdin
// (piped or pasted), NEVER from argv (argv leaks via process listings), and is
// never written anywhere except the hash printed for the operator to store.
//
// Usage:
//   node scripts/operator.mjs init          # prompts email + password, prints env lines
//   node scripts/operator.mjs hash          # prints OPERATOR_PASSWORD_HASH=... for a piped password
//   echo "$OPERATOR_EMAIL" | node scripts/operator.mjs check < .env   # verifies env parses
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function ask(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => rl.question(prompt, (a) => {
    rl.close();
    resolve(a);
  }));
}

async function readPassword(prompt) {
  // No-echo best effort on TTYs. When stdin is piped, read one line as-is.
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    return new Promise((resolve) => {
      rl.on("line", (line) => {
        rl.close();
        resolve(line.replace(/\r?\n$/, ""));
      });
    });
  }
  return ask(prompt);
}

async function hashPassword(password) {
  // Same parameters as lib/auth/password.ts (kept dependency-free here).
  const { randomBytes, scrypt, timingSafeEqual } = await import("crypto");
  const { promisify } = await import("util");
  void timingSafeEqual;
  const scryptAsync = promisify(scrypt);
  const salt = randomBytes(32);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Next.js expands `$VAR` inside .env values at boot (dotenv-expand). A raw
// scrypt hash would be mangled (cost fields silently eaten), so the value
// stored in .env MUST escape every `$` as `\$`. This function produces the
// exact file form; getAuthConfig() validates the post-expansion shape and
// fails closed if it is wrong.
function forEnvFile(hash) {
  return hash.replace(/\$/g, "\\$");
}

function fromEnvFile(stored) {
  return stored.replace(/\\\$/g, "$");
}

function hashShapeOk(hash) {
  return /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash);
}

const cmd = process.argv[2];
try {
  if (cmd === "init") {
    const email = ((await ask("Operator email: ")) ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("not a plausible email");
    const pw1 = await readPassword("New operator password (min 12 chars, input hidden where supported): ");
    const pw2 = await readPassword("Repeat password: ");
    if (pw1 !== pw2) throw new Error("passwords do not match");
    if (pw1.length < 12) throw new Error("password must be at least 12 characters");
    const hash = await hashPassword(pw1);
    console.log("\nAdd these lines to your UNTRACKED .env (never commit, never log):\n");
    console.log(`OPERATOR_EMAIL=${email}`);
    console.log(`OPERATOR_PASSWORD_HASH=${forEnvFile(hash)}`);
    console.log("\n(The $ characters are escaped as \\$ because Next.js expands");
    console.log("$VAR inside .env at boot. Paste the line EXACTLY as printed.)");
    console.log("\nThen restart the app. Existing sessions are unaffected until you revoke them.");
  } else if (cmd === "hash") {
    const pw = await readPassword("");
    if (pw.length < 12) throw new Error("password must be at least 12 characters");
    console.log(`OPERATOR_PASSWORD_HASH=${forEnvFile(await hashPassword(pw))}`);
  } else if (cmd === "check") {
    // Verifies an env file parses and carries a provisioned credential shape.
    // Reads the FILE form (escaped) and validates what Next will see after
    // expansion, so misconfiguration is caught here instead of as a mystery
    // login failure.
    const file = process.argv[3] ?? join(ROOT, ".env");
    const text = readFileSync(file, "utf8");
    const get = (k) => (text.match(new RegExp(`^${k}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
    const email = get("OPERATOR_EMAIL");
    const stored = get("OPERATOR_PASSWORD_HASH");
    const okEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (/(?<!\\)\$/.test(stored)) {
      console.log(`OPERATOR_EMAIL: ${okEmail ? "present" : "MISSING/INVALID"}`);
      console.log("OPERATOR_PASSWORD_HASH: INVALID - contains unescaped $ which Next.js will expand/mangle.");
      console.log("Regenerate with `node scripts/operator.mjs hash` and paste the line EXACTLY as printed.");
      process.exit(1);
    }
    const okHash = hashShapeOk(fromEnvFile(stored));
    console.log(`OPERATOR_EMAIL: ${okEmail ? "present" : "MISSING/INVALID"}`);
    console.log(`OPERATOR_PASSWORD_HASH: ${okHash ? "present" : "MISSING/INVALID"}`);
    if (!okEmail || !okHash) process.exit(1);
  } else {
    console.error("usage: node scripts/operator.mjs <init|hash|check [.env-file]>");
    process.exit(2);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
