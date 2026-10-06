import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { scratchDir } from "./harness.mjs";

const require = createRequire(import.meta.url);
const { getRootDirs } = require(path.join(path.dirname(require.resolve("@next/eslint-plugin-next")), "utils/get-root-dirs.js"));
const root = scratchDir("htsdesk-lint-glob-");
for (const name of ["first", "second"]) fs.mkdirSync(path.join(root, name, "nested"), { recursive: true });
const context = rootDir => ({ cwd: root, settings: { next: { rootDir } } });
assert.deepEqual(getRootDirs(context(undefined)), [root]);
assert.deepEqual(getRootDirs(context(`${root}/{first,second}`)).sort(), [path.join(root, "first"), path.join(root, "second")]);
assert.deepEqual(getRootDirs(context([`${root}/first`, `${root}/second`])).sort(), [path.join(root, "first"), path.join(root, "second")]);
console.log("Next lint root globs retain exact-directory semantics without the vulnerable dependency chain.");
