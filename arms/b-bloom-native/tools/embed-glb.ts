// Rewrites a GLB so every external image URI is embedded into its BIN chunk.
// The web target loads models from bytes only (no base directory), so external
// `../textures/*.png` references in track.glb would not resolve in the browser.
//
// Usage: node tools/embed-glb.ts <in.glb> <out.glb>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: embed-glb <in.glb> <out.glb>");
  process.exit(2);
}

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB: " + inPath);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
let bin: Buffer = Buffer.alloc(0);
const binStart = 20 + jsonLen;
if (binStart + 8 <= buf.length && buf.readUInt32LE(binStart + 4) === 0x004e4942) {
  const binLen = buf.readUInt32LE(binStart);
  bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
}

const pad4 = (n: number) => (n + 3) & ~3;
const parts: Buffer[] = [bin, Buffer.alloc(pad4(bin.length) - bin.length)];
let offset = pad4(bin.length);
gltf.bufferViews = gltf.bufferViews ?? [];
let embedded = 0;
for (const img of gltf.images ?? []) {
  if (typeof img.uri !== "string" || img.uri.startsWith("data:")) continue;
  const file = resolve(dirname(inPath), decodeURIComponent(img.uri));
  const data = readFileSync(file);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  img.bufferView = gltf.bufferViews.length - 1;
  img.mimeType = img.mimeType ?? (/\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png");
  delete img.uri;
  parts.push(data, Buffer.alloc(pad4(data.length) - data.length));
  offset += pad4(data.length);
  embedded++;
}
const newBin = Buffer.concat(parts);
gltf.buffers = gltf.buffers ?? [{}];
gltf.buffers[0].byteLength = newBin.length;
delete gltf.buffers[0].uri;

let json = Buffer.from(JSON.stringify(gltf), "utf8");
json = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + newBin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(newBin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(outPath, Buffer.concat([header, jh, json, bh, newBin]));
console.log(`embedded ${embedded} image(s): ${outPath} (${(newBin.length / 1048576).toFixed(1)} MB bin)`);
