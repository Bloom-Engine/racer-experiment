"""Group Perry runtime self time (under JS frames) by mechanism. Usage: python3 -I categorize.py sample.txt"""
import re, sys
from collections import defaultdict
sys.path.insert(0, __file__.rsplit("/", 1)[0])
line_re = re.compile(r'^(?P<prefix>[\s+!:|]*)(?P<count>\d+)\s+(?P<name>.+?)\s+\(in (?P<lib>[^)]+)\)')
def demangle(n):
    if not n.startswith("_R"): return n
    out, i = [], 0
    while i < len(n):
        m = re.match(r'(\d+)', n[i:])
        if m:
            L = int(m.group(1)); j = i + len(m.group(1))
            if n[j:j+1] == "_": j += 1
            ident = n[j:j+L]
            if re.match(r'^[a-z_][a-z0-9_]*$', ident) and ident != "perry_runtime": out.append(ident)
            i = j + L if L > 0 else i + 1
        else: i += 1
    return "::".join(out) or n
CATS = [
  ("for...in / key enumeration", r'for_in|enumeration|keys_stable|own_keys|property_names|own_property_names|object_keys'),
  ("missing / inherited lookup (prototype walk)", r'inherited|prototype|get_prototype|proto_chain|miss'),
  ("instanceof", r'instanceof'),
  ("getter/setter dispatch", r'accessor|descriptor_state|descriptor|intercept'),
  ("method call dispatch", r'native_call_method|family_method|class_holder|method_lookup|call_method|closure_call|abi_trampoline|dispatch'),
  ("Map / WeakMap / Set", r'weakref|\bmap\b|map::|set::|js_map|js_set|_bm_|string_key'),
  ("strings (to_string, utf8, concat, compare)", r'to_string|from_utf8|concat|memcmp|string|template'),
  ("thread-local access (_tlv_get_addr)", r'_tlv_get_addr|tls'),
  ("field write / GC write barrier", r'barrier|put_value|store|set_field|field_set_by|probe_set|overflow'),
  ("generic property read (shape probe)", r'probe|indexed|owned_get|value_at|computed|field_get|keys_lookup|shape|get_field|get_property|dyn_index|read_plan'),
  ("arrays", r'array'),
  ("GC / allocation", r'gc|alloc|malloc|free|nursery'),
]
nodes, stack, in_tree = [], [], False
for raw in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if raw.startswith("Call graph:"): in_tree = True; continue
    if not in_tree: continue
    if raw.startswith(("Total number", "Sort by")): break
    m = line_re.match(raw)
    if not m: continue
    d = len(m.group("prefix")); c = int(m.group("count"))
    while stack and nodes[stack[-1]][0] >= d: stack.pop()
    p = stack[-1] if stack else -1
    nodes.append([d, m.group("name"), m.group("lib"), c, 0, p])
    if p >= 0: nodes[p][4] += c
    stack.append(len(nodes) - 1)
is_js = lambda n: n.startswith(("perry_method_", "perry_fn_", "perry_closure", "perry_func_"))
cat, total, js_self, names = defaultdict(int), 0, 0, defaultdict(int)
for d, name, lib, c, ch, p in nodes:
    s = max(0, c - ch)
    if not s: continue
    q = p
    while q >= 0 and not is_js(nodes[q][1]): q = nodes[q][5]
    if q < 0 and not is_js(name): continue
    total += s
    if is_js(name): js_self += s; continue
    dn = demangle(name); names[dn] += s
    for label, rx in CATS:
        if re.search(rx, dn): cat[label] += s; break
    else: cat["other runtime"] += s
print(f"{js_self*100/total:5.1f}%  compiled three.js code itself")
for k, v in sorted(cat.items(), key=lambda x: -x[1]): print(f"{v*100/total:5.1f}%  {k}")
if len(sys.argv) > 2:
    print("\ntop runtime functions:")
    for k, v in sorted(names.items(), key=lambda x: -x[1])[:int(sys.argv[2])]: print(f"  {v*100/total:5.1f}%  {k}")
