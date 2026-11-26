// Micro-benchmarks of the JS patterns three.js's per-frame renderer code relies on.
// Each test runs the same work under Node and Perry; compare ns/op. A sink keeps results observable.
import { Base, Mid, Leaf, Other1, Other2, Other3, Other4, Other5, Other6, Other7, D1, D6 } from "./classes.js";

let sink = 0;
const results = [];
function bench(name, n, fn) {
  fn(Math.min(n, 1000));                 // warm-up (matters for Node's JIT; harmless for Perry)
  const t0 = performance.now();
  const r = fn(n);
  const ms = performance.now() - t0;
  sink += typeof r === "number" ? r : 1;
  results.push([name, (ms * 1e6) / n]);
}

const N = 2_000_000;
const leaf = new Leaf();
const objs = [new Leaf(), new Other1(), new Other2(), new Other3(), new Other4(), new Other5(), new Other6(), new Other7()];
const plain = { x: 1, y: 2, z: 3 };

bench("own field read (class instance)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.x; return s; });
bench("own field write (class instance)", N, (n) => { for (let i = 0; i < n; i++) leaf.x = i; return leaf.x; });
bench("plain object field read", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.y; return s; });
bench("method defined on same class", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.own(); return s; });
bench("method inherited 2 levels up", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.base(); return s; });
bench("super.method() call chain", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.chain(); return s; });
bench("getter on class (get x())", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.computed; return s; });
bench("getter inherited from base class", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.baseGetter; return s; });
bench("setter on class (set x())", N, (n) => { for (let i = 0; i < n; i++) leaf.prop = i; return leaf._prop; });
bench("field set by base constructor, read on leaf", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf.baseField; return s; });
bench("missing property read (=== undefined)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (leaf.notThere === undefined) s++; return s; });
bench("polymorphic read, 8 classes (o.isNode)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (objs[i & 7].isNode) s++; return s; });
bench("polymorphic method call, 8 classes", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += objs[i & 7].poly(); return s; });
const keys = ["x", "y", "z", "baseField"];
bench("dynamic key read obj[key]", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain[keys[i % 3]]; return s; });
bench("dynamic key read on class instance", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += leaf[keys[i & 3]]; return s; });
bench("instanceof (3-level hierarchy)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (objs[i & 7] instanceof Base) s++; return s; });
const fnProp = { call: (a) => a + 1 };
bench("closure stored as property, called", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s = fnProp.call(s); return s; });
const map = new Map(); const wm = new WeakMap(); for (const o of objs) { map.set(o, 1); wm.set(o, 1); }
bench("Map.get(object key)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += map.get(objs[i & 7]); return s; });
bench("WeakMap.get(object key)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += wm.get(objs[i & 7]); return s; });
const smap = new Map([["a", 1], ["bb", 2], ["ccc", 3]]); const sk = ["a", "bb", "ccc"];
bench("Map.get(string key)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += smap.get(sk[i % 3]); return s; });
bench("Math.imul", N, (n) => { let h = 7; for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return h; });
bench("string concat (cache key)", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) s += ("node" + i + ":" + (i & 7)).length; return s; });
bench("number to string", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) s += String(i).length; return s; });
const big = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
bench("for...in over 8 keys", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) for (const k in big) s += big[k]; return s; });
bench("object literal {a,b,c} creation", N, (n) => { let s = 0; for (let i = 0; i < n; i++) { const o = { a: i, b: 2, c: 3 }; s += o.a; } return s; });
bench("new class instance", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += new Other1().x; return s; });
const arr = [];
bench("array push + pop", N, (n) => { for (let i = 0; i < n; i++) { arr.push(i); if (arr.length > 64) arr.length = 0; } return arr.length; });
const f32 = new Float32Array(16);
bench("Float32Array write+read", N, (n) => { let s = 0; for (let i = 0; i < n; i++) { f32[i & 15] = i; s += f32[(i + 3) & 15]; } return s; });
bench("Array of numbers read", N, (n) => { const a = [1, 2, 3, 4, 5, 6, 7, 8]; let s = 0; for (let i = 0; i < n; i++) s += a[i & 7]; return s; });

bench("Object.getOwnPropertyNames(instance)", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) s += Object.getOwnPropertyNames(leaf).length; return s; });
bench("Object.keys(plain 8 keys)", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) s += Object.keys(big).length; return s; });
bench("Object.getPrototypeOf", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (Object.getPrototypeOf(objs[i & 7]) === Object.prototype) s++; return s; });
const seen = new Set(objs.slice(0, 4));
bench("Set.has(object)", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (seen.has(objs[i & 7])) s++; return s; });
bench("Array.isArray", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (Array.isArray(objs)) s++; return s; });
bench("typeof x === 'object'", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (typeof objs[i & 7] === "object") s++; return s; });

const d1 = new D1(), d6 = new D6();
bench("missing prop, 1-level class", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (d1.isPoints) s++; return s; });
bench("missing prop, 6-level class", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (d6.isPoints) s++; return s; });
bench("missing prop, plain object", N, (n) => { let s = 0; for (let i = 0; i < n; i++) if (plain.isPoints) s++; return s; });
bench("method inherited 5 levels up", N, (n) => { let s = 0; for (let i = 0; i < n; i++) s += d6.m1(); return s; });
bench("write existing own field, 6-level class", N, (n) => { for (let i = 0; i < n; i++) d6.v = i; return d6.v; });
bench("write existing field, plain object", N, (n) => { for (let i = 0; i < n; i++) plain.x = i; return plain.x; });
bench("add new property to fresh object", N / 10, (n) => { let s = 0; for (let i = 0; i < n; i++) { const o = new D1(); o.extra = i; s += o.extra; } return s; });

const name = process.argv[2] ?? "run";
console.log(JSON.stringify({ name, sink: sink > 0, results }));
