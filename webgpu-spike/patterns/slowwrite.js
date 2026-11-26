import { F1, L4 } from "./bisect-classes.js";
const o = new F1(), q = new L4();
const which = process.argv[2] === "fast" ? q : o;
const t0 = performance.now(); for (let i = 0; i < 600_000_000; i++) which.x = i; console.log(((performance.now() - t0) * 1e6 / 6e8).toFixed(2), "ns", which.x > 0);
