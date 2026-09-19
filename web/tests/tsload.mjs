/** Loads the real TypeScript modules under src/lib into a test, without a
 *  second copy of their logic.
 *
 *  Node 20 cannot import .ts, so each module is transpiled (types stripped,
 *  nothing else changed) into a scratch directory and imported from there.
 *  Only the pure lib modules are meant to be loaded this way: they must not
 *  depend on the app's runtime (the account store, next/*).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchDir } from "./harness.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript");

let outDir;

export async function loadLib(name) {
  outDir ??= scratchDir("htsdesk-ts-");
  const seen = new Set();
  const emit = (mod) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    const src = fs.readFileSync(path.join(WEB, "src", "lib", `${mod}.ts`), "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    // "./x" -> "./x.mjs", following each relative import.
    const rewritten = js.replace(/from "\.\/([\w-]+)"/g, (_, dep) => {
      emit(dep);
      return `from "./${dep}.mjs"`;
    });
    fs.writeFileSync(path.join(outDir, `${mod}.mjs`), rewritten);
  };
  emit(name);
  return import(pathToFileURL(path.join(outDir, `${name}.mjs`)).href);
}
