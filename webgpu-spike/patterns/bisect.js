import { L0, L1, L2, L3, L4, F1, F2 } from "./bisect-classes.js";
const N = 5_000_000;
function t(name, o) { const t0 = performance.now(); for (let i = 0; i < N; i++) o.x = i; console.log(name.padEnd(44), ((performance.now() - t0) * 1e6 / N).toFixed(2), "ns", o.x > 0); }
t("L0 = Leaf (getter + setter on leaf)", new L0());
t("L1 no setter", new L1());
t("L2 no getter (setter only)", new L2());
t("L3 no accessors", new L3());
t("L4 setter only, no methods", new L4());
t("F1 flat, setter only (set prop)", new F1());
t("F2 flat, get/set pair (p)", new F2());
