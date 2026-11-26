export class NoAcc { constructor() { this.v = 0; } }
export class WithAcc { constructor() { this.v = 0; this._w = 0; } get w() { return this._w; } set w(x) { this._w = x; } }
export class ChildOfAcc extends WithAcc { constructor() { super(); this.u = 1; } }
