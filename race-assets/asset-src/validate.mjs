// Validates every .glb under assets/ with the Khronos glTF validator and the
// manifest against manifest.schema.json (JSON Schema 2020-12, ajv).
// Exit code 1 on any glTF error or schema violation. Writes assets/reports/validation.json.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const validator = require("gltf-validator");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let failed = false;
const report = { gltf: {}, manifest: null };

for (const file of walk(ASSETS).filter((f) => f.endsWith(".glb")).sort()) {
  const rel = relative(ASSETS, file);
  const res = await validator.validateBytes(new Uint8Array(readFileSync(file)), {
    uri: rel,
    maxIssues: 200,
    externalResourceFunction: (uri) =>
      new Promise((ok, fail) => {
        try { ok(new Uint8Array(readFileSync(join(dirname(file), decodeURIComponent(uri))))); }
        catch (e) { fail(e.toString()); }
      }),
  });
  const i = res.issues;
  report.gltf[rel] = {
    errors: i.numErrors, warnings: i.numWarnings, infos: i.numInfos, hints: i.numHints,
    messages: i.messages.map((m) => ({ code: m.code, severity: ["error", "warning", "info", "hint"][m.severity], pointer: m.pointer, message: m.message })),
    stats: { triangles: res.info?.totalTriangleCount, drawCalls: res.info?.drawCallCount, materials: res.info?.materialCount,
             extensionsUsed: res.info?.extensionsUsed },
  };
  console.log(`  glTF ${rel}: ${i.numErrors} errors, ${i.numWarnings} warnings, ${i.numInfos} infos` +
              ` (validator: ${res.info?.totalTriangleCount} tris, ${res.info?.drawCallCount} draw calls)`);
  for (const m of i.messages.filter((m) => m.severity <= 1)) console.log(`     ${m.code} ${m.pointer}: ${m.message}`);
  if (i.numErrors > 0) failed = true;
}

const schema = JSON.parse(readFileSync(join(ASSETS, "manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ASSETS, "manifest.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const ok = ajv.validate(schema, manifest);
report.manifest = { valid: ok, errors: ajv.errors || [] };
console.log(`  manifest.json vs manifest.schema.json: ${ok ? "valid" : "INVALID"}`);
if (!ok) {
  for (const e of ajv.errors) console.log(`     ${e.instancePath} ${e.message}`);
  failed = true;
}

mkdirSync(join(ASSETS, "reports"), { recursive: true });
writeFileSync(join(ASSETS, "reports", "validation.json"), JSON.stringify(report, null, 1) + "\n");
process.exit(failed ? 1 : 0);
