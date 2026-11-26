#!/usr/bin/env node
// Bakes the ground's colours (bloom/assets/folio/terrain/terrainColor.png) from the game's terrain data
// texture (static/terrain/terrain.png: R slabs, G grass, B depth), with the rules of the game's floor shader
// (Terrain.colorNode + Floor's slab mix): the dirt/shore/water gradient by depth, grass mixed over it,
// paving slabs where R is set. The native build draws terrain.glb with it (folio.ts), since Bloom can't
// run that shader. No dependencies: 8-bit RGBA PNGs are decoded and encoded with zlib.
//   node bloom/bake-terrain.mjs <terrain.png> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

function decodePng(buf) {
  let p = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12] !== 0) throw new Error("interlaced PNG"); }
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = { 6: 4, 2: 3, 0: 1, 4: 2 }[type];
  if (depth !== 8 || channels === undefined) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * channels, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[i] = (line[i] + pred) & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * channels, d = (y * w + x) * 4;
      if (channels >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; } else { out[d] = out[d + 1] = out[d + 2] = line[s]; }
      out[d + 3] = channels === 4 ? line[s + 3] : channels === 2 ? line[s + 1] : 255;
    }
    prev = line;
  }
  return { w, h, rgba: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(kind, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, "ascii");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function encodePng(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// the game's colours (Terrain.js setGradient / setNodes, Floor.js setVisual), in sRGB
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const stops = [[0.1, hex("#ffa94e")], [0.3, hex("#5bc2b9")], [0.9, hex("#13375f")]];
const grass = hex("#b8b62e"), slabLow = hex("#a87762"), slabHigh = hex("#ffcf8b");
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
function gradient(t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [s0, c0] = stops[i - 1], [s1, c1] = stops[i]; return mix(c0, c1, (t - s0) / (s1 - s0)); }
  return stops[stops.length - 1][1];
}

const [input, output] = process.argv.slice(2);
const { w, h, rgba } = decodePng(readFileSync(input));
const out = Buffer.alloc(w * h * 3);
for (let i = 0; i < w * h; i++) {
  const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
  let c = mix(gradient(b), grass, g);
  // slabs: the shader modulates them with a perlin noise and a slab pattern; on average about half strength
  c = mix(c, mix(slabLow, slabHigh, 0.5), r * 0.5);
  out[i * 3] = Math.round(c[0]); out[i * 3 + 1] = Math.round(c[1]); out[i * 3 + 2] = Math.round(c[2]);
}
writeFileSync(output, encodePng(w, h, out));
console.log(`${output}: ${w}x${h} ground colours baked from ${input}`);
