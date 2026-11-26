const N = 5_000_000;
class C2 { constructor() { this.f0 = 0; this.f1 = 1; } }
class C3 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; } }
class C4 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; } }
class C5 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; } }
class C6 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; } }
class C7 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; } }
class C8 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; this.f7 = 7; } }
class C10 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; this.f7 = 7; this.f8 = 8; this.f9 = 9; } }
class C12 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; this.f7 = 7; this.f8 = 8; this.f9 = 9; this.f10 = 10; this.f11 = 11; } }
class C16 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; this.f7 = 7; this.f8 = 8; this.f9 = 9; this.f10 = 10; this.f11 = 11; this.f12 = 12; this.f13 = 13; this.f14 = 14; this.f15 = 15; } }
class C24 { constructor() { this.f0 = 0; this.f1 = 1; this.f2 = 2; this.f3 = 3; this.f4 = 4; this.f5 = 5; this.f6 = 6; this.f7 = 7; this.f8 = 8; this.f9 = 9; this.f10 = 10; this.f11 = 11; this.f12 = 12; this.f13 = 13; this.f14 = 14; this.f15 = 15; this.f16 = 16; this.f17 = 17; this.f18 = 18; this.f19 = 19; this.f20 = 20; this.f21 = 21; this.f22 = 22; this.f23 = 23; } }
function w(k, o, key) { const t0 = performance.now(); for (let i = 0; i < N; i++) o[key] = i; return ((performance.now() - t0) * 1e6 / N); }
{ const o = new C2(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f1 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f1; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 2 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C3(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f2 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f2; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 3 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C4(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f3 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f3; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 4 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C5(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f4 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f4; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 5 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C6(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f5 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f5; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 6 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C7(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f6 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f6; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 7 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C8(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f7 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f7; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log(" 8 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C10(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f9 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f9; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log("10 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C12(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f11 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f11; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log("12 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C16(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f15 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f15; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log("16 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
{ const o = new C24(); let t0 = performance.now(); for (let i = 0; i < N; i++) o.f23 = i; const wns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += o.f23; const rns = (performance.now() - t0) * 1e6 / N;
  t0 = performance.now(); for (let i = 0; i < N; i++) o.f0 = i; const w0 = (performance.now() - t0) * 1e6 / N;
  console.log("24 fields: write last " + wns.toFixed(2) + " ns, read last " + rns.toFixed(2) + " ns, write first " + w0.toFixed(2) + " ns", s > 0); }
