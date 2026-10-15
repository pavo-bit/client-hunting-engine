// Registers scripts/ts-resolve.mjs for operator scripts (see that file).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "ts-resolve.mjs")).href);
