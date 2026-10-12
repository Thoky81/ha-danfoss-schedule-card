"""Check pyscript/climate_schedule.py for things pyscript can't load (run before every backend release).

- Python syntax pyscript doesn't implement (e.g. generator expressions): compared with the
  ast_* handlers of pyscript's evaluator, fetched from GitHub (or a local copy passed as argv[1]).
- @service docstrings must be valid YAML, or pyscript skips the whole file.
Usage: python3 tests/pyscript_check.py [path/to/pyscript/eval.py]   (needs PyYAML)
"""
import ast
import re
import sys
import urllib.request
from pathlib import Path

import yaml

SRC = Path(__file__).resolve().parent.parent / "pyscript" / "climate_schedule.py"
EVAL_URL = "https://raw.githubusercontent.com/custom-components/pyscript/master/custom_components/pyscript/eval.py"

eval_src = Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else urllib.request.urlopen(EVAL_URL, timeout=30).read().decode()
supported = set(re.findall(r"async def ast_([a-z_]+)\(", eval_src))
tree = ast.parse(SRC.read_text())

native = set()  # @pyscript_compile functions run as plain Python
for n in ast.walk(tree):
    if isinstance(n, ast.FunctionDef) and any(isinstance(d, ast.Name) and d.id == "pyscript_compile" for d in n.decorator_list):
        native |= {id(x) for x in ast.walk(n)}

helpers = (ast.operator, ast.unaryop, ast.cmpop, ast.boolop, ast.expr_context, ast.arguments, ast.arg, ast.keyword,
           ast.alias, ast.comprehension, ast.withitem, ast.excepthandler, ast.Module)
bad = {}
for n in ast.walk(tree):
    if id(n) in native or isinstance(n, helpers):
        continue
    name = type(n).__name__.lower()
    if name not in supported:
        bad.setdefault(name, []).append(getattr(n, "lineno", "?"))

yaml_bad = []
for n in tree.body:
    doc = isinstance(n, ast.FunctionDef) and ast.get_docstring(n, clean=False)
    if doc and doc.startswith("yaml"):
        try:
            yaml.safe_load(doc[4:])
        except yaml.YAMLError as e:
            yaml_bad.append(f"{n.name}: {' '.join(str(e).split())}")

print("unsupported syntax:", bad or "none")
print("service YAML:", yaml_bad or "ok")
sys.exit(1 if bad or yaml_bad else 0)
