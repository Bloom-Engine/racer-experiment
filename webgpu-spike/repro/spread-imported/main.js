// Perry bug: spreading arguments into the constructor of a class imported from another module
// passes the whole array as the first argument. A class from the same module works.
// node:  [1,2,3] [1,2,3]     perry (main 1095f50fc5 and 0.5.1664): [1,2,3] [[1,2,3],0,0]
import { V3 } from "./vec.js";
class Local { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
const args = [1, 2, 3];
const a = new Local(...args), b = new V3(...args);
console.log(JSON.stringify([a.x, a.y, a.z]), JSON.stringify([b.x, b.y, b.z]));
