// Leaf's exact structure, then variants with one feature removed each
export class B0 { constructor() { this.isNode = true; this.baseField = 3; this.uuid = "u"; } base() { return 1; } chain() { return 1; } get baseGetter() { return this.baseField; } poly() { return 1; } }
export class M0 extends B0 { constructor() { super(); this.isMid = true; } chain() { return super.chain() + 1; } }
export class L0 extends M0 { constructor() { super(); this.x = 1; this._prop = 0; } own() { return 2; } chain() { return super.chain() + 1; } get computed() { return this.x + 1; } set prop(v) { this._prop = v; } poly() { return 2; } }
// no setter on the leaf
export class L1 extends M0 { constructor() { super(); this.x = 1; this._prop = 0; } own() { return 2; } chain() { return super.chain() + 1; } get computed() { return this.x + 1; } poly() { return 2; } }
// no getter on the leaf
export class L2 extends M0 { constructor() { super(); this.x = 1; this._prop = 0; } own() { return 2; } chain() { return super.chain() + 1; } set prop(v) { this._prop = v; } poly() { return 2; } }
// no accessors on the leaf at all
export class L3 extends M0 { constructor() { super(); this.x = 1; this._prop = 0; } own() { return 2; } chain() { return super.chain() + 1; } poly() { return 2; } }
// setter only, no other methods
export class L4 extends M0 { constructor() { super(); this.x = 1; this._prop = 0; } set prop(v) { this._prop = v; } }
// flat class with just a setter for a different property
export class F1 { constructor() { this.x = 1; this._prop = 0; } set prop(v) { this._prop = v; } }
// flat class with getter+setter pair for a different property
export class F2 { constructor() { this.x = 1; this._p = 0; } get p() { return this._p; } set p(v) { this._p = v; } }
