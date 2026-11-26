// Perry bug: a variable declared as null and later assigned a string returns false from .includes().
// node: true true     perry (main 1095f50fc5): true false
const direct = "<";
let late = null;
late = "<";
console.log(direct.includes("<"), late.includes("<"));
