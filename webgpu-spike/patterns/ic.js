class K0 { constructor() { this.k0 = 0; this.x = 1; } }
class K1 { constructor() { this.k1 = 1; this.x = 1; } }
class K2 { constructor() { this.k2 = 2; this.x = 1; } }
class K3 { constructor() { this.k3 = 3; this.x = 1; } }
class K4 { constructor() { this.k4 = 4; this.x = 1; } }
class K5 { constructor() { this.k5 = 5; this.x = 1; } }
class K6 { constructor() { this.k6 = 6; this.x = 1; } }
class K7 { constructor() { this.k7 = 7; this.x = 1; } }
const N = 3_000_000;
function t(name, o) { const t0 = performance.now(); for (let i = 0; i < N; i++) o.x = i; return ((performance.now() - t0) * 1e6 / N).toFixed(1); }
function r(name, o) { const t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.x; return ((performance.now() - t0) * 1e6 / N).toFixed(1); }
const objs = [new K0(), new K1(), new K2(), new K3(), new K4(), new K5(), new K6(), new K7()];
console.log("write, shared site, order K0..K7:", objs.map((o, i) => t("K" + i, o)).join("  "));
console.log("write, same site again, K0..K7:   ", objs.map((o, i) => t("K" + i, o)).join("  "));
const objs2 = [new K7(), new K6(), new K5(), new K4(), new K3(), new K2(), new K1(), new K0()];
function t2(name, o) { const t0 = performance.now(); for (let i = 0; i < N; i++) o.x = i; return ((performance.now() - t0) * 1e6 / N).toFixed(1); }
console.log("write, fresh site, order K7..K0:  ", objs2.map((o, i) => t2("K" + (7 - i), o)).join("  "));
console.log("read,  shared site, order K0..K7: ", objs.map((o, i) => r("K" + i, o)).join("  "));
