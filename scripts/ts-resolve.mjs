// Node resolve hook: map extensionless relative imports to .ts files.
//
// `node --experimental-strip-types` executes TypeScript but does NOT resolve
// extensionless relative imports (which this repo uses by convention outside
// lib/qualification). Rewriting every stable file's import style for the
// operator scripts would churn reviewed code for tooling reasons, so scripts
// register this hook instead: `node --experimental-strip-types
// --import ./scripts/ts-register.mjs scripts/<cmd>.mjs`.
// Vitest, tsc and Next resolve the same files their own way and never load this.
import { existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve as resolvePath } from "path";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = resolvePath(dirname(parentPath), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
