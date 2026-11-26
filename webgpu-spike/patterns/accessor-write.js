import { NoAcc, WithAcc, ChildOfAcc } from "./acc-classes.js";
const a = new NoAcc(), b = new WithAcc(), c = new ChildOfAcc();
const N = 5_000_000;
function t(name, o) { const t0 = performance.now(); for (let i = 0; i < N; i++) o.v = i; const ns = (performance.now() - t0) * 1e6 / N; console.log(name.padEnd(46), ns.toFixed(2), "ns", o.v > 0); }
t("write own field, class without accessors", a);
t("write own field, class with a getter/setter", b);
t("write own field, subclass of class with accessor", c);
const t0 = performance.now(); let s = 0; for (let i = 0; i < N / 10; i++) { const o = {}; o.frameId = i; s += o.frameId; } console.log("add property to empty {} (like _getMaps)".padEnd(46), ((performance.now() - t0) * 1e6 / (N / 10)).toFixed(2), "ns", s > 0);
