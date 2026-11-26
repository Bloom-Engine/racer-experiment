// A class hierarchy shaped like three.js's (Node -> TempNode -> OperatorNode ...), in its own module
// because three.js's classes are imported across modules.
export class Base {
  constructor() { this.isNode = true; this.baseField = 3; this.uuid = "u"; }
  base() { return 1; }
  chain() { return 1; }
  get baseGetter() { return this.baseField; }
  poly() { return 1; }
}
export class Mid extends Base {
  constructor() { super(); this.isMid = true; }
  chain() { return super.chain() + 1; }
}
export class Leaf extends Mid {
  constructor() { super(); this.x = 1; this._prop = 0; }
  own() { return 2; }
  chain() { return super.chain() + 1; }
  get computed() { return this.x + 1; }
  set prop(v) { this._prop = v; }
  poly() { return 2; }
}
export class Other1 extends Base { constructor() { super(); this.x = 1; } poly() { return 3; } }
export class Other2 extends Base { constructor() { super(); this.a = 1; } poly() { return 4; } }
export class Other3 extends Base { constructor() { super(); this.b = 1; } poly() { return 5; } }
export class Other4 extends Mid { constructor() { super(); this.c = 1; } poly() { return 6; } }
export class Other5 extends Mid { constructor() { super(); this.d = 1; } }
export class Other6 extends Base { constructor() { super(); this.e = 1; this.f = 2; } }
export class Other7 extends Base { constructor() { super(); this.g = 1; } poly() { return 7; } }
// a deeper chain, like three's Mesh -> Object3D -> EventDispatcher or OperatorNode -> TempNode -> Node
export class D1 { constructor() { this.isD1 = true; } m1() { return 1; } }
export class D2 extends D1 { constructor() { super(); this.isD2 = true; } }
export class D3 extends D2 { constructor() { super(); this.isD3 = true; } }
export class D4 extends D3 { constructor() { super(); this.isD4 = true; } }
export class D5 extends D4 { constructor() { super(); this.isD5 = true; } }
export class D6 extends D5 { constructor() { super(); this.isD6 = true; this.v = 1; } }
