"""Where does Perry spend its time, and which JS function caused it?

Reads a macOS `sample` call tree, computes self time per node (count minus children), and charges the
self time of every runtime frame to the nearest compiled-JS ancestor (perry_method_*/perry_fn_*/closures).
Prints: overall split (JS code vs runtime vs other), the runtime functions with most self time, and the
JS functions that cause most runtime time, with their top runtime callees.
Usage: python3 -I attribute.py out/sample.txt [top]
"""
import re, sys
from collections import defaultdict

path = sys.argv[1]
top = int(sys.argv[2]) if len(sys.argv) > 2 else 30
line_re = re.compile(r'^(?P<prefix>[\s+!:|]*)(?P<count>\d+)\s+(?P<name>.+?)\s+\(in (?P<lib>[^)]+)\)')

def is_js(n):
    return n.startswith(("perry_method_", "perry_fn_", "perry_closure", "perry_func_", "perry_init_"))

def short(n):
    n = re.sub(r'^perry_(method|fn|func|closure)_node_modules_three_build_three_(webgpu|tsl|core)_js__', r'\2:', n)
    n = re.sub(r'^perry_(method|fn|func)_', '', n)
    return n[:80]

def rt_short(n):
    if not n.startswith("_R"): return n[:60]
    parts = re.findall(r'\d+([A-Za-z_][A-Za-z0-9_]*)', n)
    parts = [p for p in parts if p not in ("perry_runtime",) and not re.match(r'^Cs', p)]
    return "::".join(parts[-3:])[:60]

nodes = []   # [depth, name, lib, count, children_sum, parent_index]
stack = []
in_tree = False
for raw in open(path, encoding="utf-8", errors="replace"):
    if raw.startswith("Call graph:"): in_tree = True; continue
    if not in_tree: continue
    if raw.startswith(("Total number", "Sort by")): break
    m = line_re.match(raw)
    if not m: continue
    depth = len(m.group("prefix")); count = int(m.group("count"))
    while stack and nodes[stack[-1]][0] >= depth: stack.pop()
    parent = stack[-1] if stack else -1
    nodes.append([depth, m.group("name"), m.group("lib"), count, 0, parent])
    if parent >= 0: nodes[parent][4] += count
    stack.append(len(nodes) - 1)

js_rt = defaultdict(int); js_detail = defaultdict(lambda: defaultdict(int))
rt_self = defaultdict(int); buckets = defaultdict(int); total = 0
# only the main thread's work inside the frame loop: nodes under a JS frame
for i, (depth, name, lib, count, child, parent) in enumerate(nodes):
    self_n = max(0, count - child)
    if self_n == 0: continue
    p = parent; js = None
    while p >= 0:
        if is_js(nodes[p][1]): js = nodes[p][1]; break
        p = nodes[p][5]
    if js is None and not is_js(name): continue   # idle threads, startup, etc.
    total += self_n
    if is_js(name): buckets["compiled JS code (self)"] += self_n; continue
    kind = "runtime (perry)" if "spike" in lib else f"system ({lib})"
    buckets[kind] += self_n
    rt_self[rt_short(name)] += self_n
    js_rt[short(js)] += self_n; js_detail[short(js)][rt_short(name)] += self_n

print(f"samples under JS frames: {total}")
for k, v in sorted(buckets.items(), key=lambda x: -x[1]): print(f"  {v*100/total:5.1f}%  {k}")
print("\nruntime/system functions by self time:")
for k, v in sorted(rt_self.items(), key=lambda x: -x[1])[:top]: print(f"  {v*100/total:5.1f}%  {k}")
print("\nJS functions causing the most runtime time (self time of runtime callees):")
for fn, n in sorted(js_rt.items(), key=lambda x: -x[1])[:top]:
    d = sorted(js_detail[fn].items(), key=lambda x: -x[1])[:3]
    print(f"  {n*100/total:5.1f}%  {fn}\n           " + ", ".join(f"{k} {v*100/total:.1f}%" for k, v in d))
