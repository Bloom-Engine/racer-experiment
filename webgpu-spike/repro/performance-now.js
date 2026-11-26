// Perry: performance.now can't be replaced (test harnesses and polyfills do this).
// node: true true     perry (main 1095f50fc5): false false
const fake = () => 42;
try { Object.defineProperty(globalThis.performance, "now", { value: fake, configurable: true, writable: true }); } catch (e) {}
const a = performance.now() === 42;
globalThis.performance.now = fake;
console.log(a, performance.now() === 42);
