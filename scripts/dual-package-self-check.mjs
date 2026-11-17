import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const packages = [
  ["packages/core", "@jaytrace/core", "createTraceparent"],
  ["packages/replay-core", "@jaytrace/replay-core", "createReplayDocument"],
  ["packages/node", "@jaytrace/node", "currentTraceparent"],
  ["packages/nestjs", "@jaytrace/nestjs", "JayTraceModule"],
  ["packages/node", "@jaytrace/node/init", undefined]
];

for (const [directory, specifier, exportName] of packages) {
  const assertion = exportName
    ? `assert.equal(typeof loaded[${JSON.stringify(exportName)}], "function", "${specifier} missing ${exportName}");`
    : "";
  const cjs = `const assert = require("node:assert/strict"); const resolved = require.resolve(${JSON.stringify(specifier)}); console.log("CJS ${specifier}", resolved); assert.match(resolved, /\\.cjs$/, "${specifier} require resolved " + resolved + ", not a CJS entry"); const loaded = require(${JSON.stringify(specifier)}); ${assertion}`;
  const esm = `import assert from "node:assert/strict"; const resolved = await import.meta.resolve(${JSON.stringify(specifier)}); console.log("ESM ${specifier}", resolved); assert.match(resolved, /\\.js$/, "${specifier} import resolved " + resolved + ", not an ESM entry"); const loaded = await import(${JSON.stringify(specifier)}); ${assertion}`;

  execFileSync(process.execPath, ["--input-type=commonjs", "--eval", cjs], { cwd: `${root}${directory}`, stdio: "inherit" });
  execFileSync(process.execPath, ["--input-type=module", "--eval", esm], { cwd: `${root}${directory}`, stdio: "inherit" });
}

console.log("[jaytrace] dual-package self-check ok");
