// Next's lint plugin uses only fast-glob.globSync to locate root directories.
// Preserve its exact-directory semantics without the vulnerable braces chain.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Next loads this adapter through CommonJS.
const { globSync } = require("tinyglobby");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS adapter.
const path = require("node:path");
exports.globSync = (patterns, options) => globSync(patterns, {
  ...options,
  ...(typeof patterns === "string" && path.isAbsolute(patterns)
    ? { cwd: path.parse(patterns).root, absolute: true } : {}),
  expandDirectories: false,
}).map(path => path === "/" ? path : path.replace(/\/$/, ""));
