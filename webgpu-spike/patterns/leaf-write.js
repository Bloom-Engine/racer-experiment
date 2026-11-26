import { Leaf, D6 } from "./classes.js";
class S1 { constructor() { this.isNode = true; this.baseField = 3; this.x = 1; } }
class S2 { constructor() { this.isNode = true; this.uuid = "u"; this.x = 1; } }
class P1 { constructor() { this.isNode = true; this.baseField = 3; } }
class P2 extends P1 { constructor() { super(); this.x = 1; } }
class P3 extends P2 { constructor() { super(); this.y = 1; } }
const N = 5_000_000;
function t(name, o) { const t0 = performance.now(); for (let i = 0; i < N; i++) o.x = i; console.log(name.padEnd(52), ((performance.now() - t0) * 1e6 / N).toFixed(2), "ns", o.x > 0); }
t("Leaf (Base->Mid->Leaf, x set in Leaf ctor)", new Leaf());
t("flat class, 3 number/bool fields", new S1());
t("flat class with a string field", new S2());
t("2-level, x set in subclass ctor", new P2());
t("3-level, x set in middle ctor", new P3());
const d6 = new D6(); d6.x = 0; t("D6 + x added after construction", d6);
