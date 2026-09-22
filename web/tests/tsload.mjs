/** Loads the real TypeScript modules under src/lib into a test, without a
 *  second copy of their logic.
 *
 *  Node 20 cannot import .ts, so each module is transpiled (types stripped,
 *  nothing else changed) into a scratch directory and imported from there.
 *  A symlinked node_modules alongside it resolves a module's real npm
 *  dependencies (e.g. store.ts's @libsql/client) the normal Node way, so
 *  those load too. What still cannot be loaded this way is a module that
 *  depends on the app's *runtime*, not just its packages — next/headers and
 *  friends need an actual request context that exists only inside `next
 *  dev`/`next start`, which nothing here fakes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchDir } from "./harness.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript");

let outDir;

/** `fresh: true` returns an independent module instance (its own top-level
 *  state — for store.ts, its own cached connection) instead of the one
 *  every other `loadLib(name)` call shares. For a module such as store.ts
 *  that opens one connection and caches it, this is how a test gets several
 *  genuinely separate connections to the same database, the way several
 *  concurrent serverless invocations would in production — a plain
 *  Promise.all of calls through the single shared instance only interleaves
 *  at the JS event-loop level, on one connection, which is a weaker claim. */
export async function loadLib(name, { fresh = false } = {}) {
  if (!outDir) {
    outDir = scratchDir("htsdesk-ts-");
    fs.symlinkSync(path.join(WEB, "node_modules"), path.join(outDir, "node_modules"), "dir");
  }
  // `fresh` gives every module in the dependency chain its own suffixed
  // filename, not just the one named — a relative import rewritten to
  // "./store.mjs" would otherwise resolve to the one shared, already-cached
  // copy no matter what URL the top-level import used, defeating the point.
  const suffix = fresh ? `.i${crypto.randomUUID().replace(/-/g, "")}` : "";
  const seen = new Set();
  const emit = (mod) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    const src = fs.readFileSync(path.join(WEB, "src", "lib", `${mod}.ts`), "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    // "./x" -> "./x<suffix>.mjs", following each relative import.
    const rewritten = js.replace(/from "\.\/([\w-]+)"/g, (_, dep) => {
      emit(dep);
      return `from "./${dep}${suffix}.mjs"`;
    });
    fs.writeFileSync(path.join(outDir, `${mod}${suffix}.mjs`), rewritten);
  };
  emit(name);
  return import(pathToFileURL(path.join(outDir, `${name}${suffix}.mjs`)).href);
}
