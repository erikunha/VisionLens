#!/usr/bin/env python3
"""Offline validator for *proposal files* only; NOT validation of a running VisionLens service."""
from pathlib import Path
import csv
import hashlib
import json
import re
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[1]
ERRORS = []
SCHEMAS = ROOT / 'contracts-proposed'
FIXTURES = SCHEMAS / 'examples'


def error(s): ERRORS.append(s)


def load_json(p):
    try: return json.loads(p.read_text(encoding='utf-8'))
    except Exception as e: error(f'Invalid JSON {p.relative_to(ROOT)}: {e}'); return None


def check_schema(name):
    p = SCHEMAS / name
    obj = load_json(p)
    if obj is None: return None
    try: Draft202012Validator.check_schema(obj)
    except Exception as e: error(f'Invalid Schema {name}: {e}')
    return obj


name2schema = {x.name: check_schema(x.name) for x in sorted(SCHEMAS.glob('*.schema.json'))}
if len(name2schema) != 7: error(f'Expected 7 candidate schemas, found {len(name2schema)}')

pairs={
'job-submit.classification.v1.json':'job-submit.v1.schema.json',
'job-resource.queued.v1.json':'job-resource.v1.schema.json',
'job-resource.succeeded.v1.json':'job-resource.v1.schema.json',
'job-result.classification.v1.json':'job-result.v1.schema.json',
'job-event.progress.v1.json':'job-event.v1.schema.json',
'problem-details.idempotency.v1.json':'problem-details.v1.schema.json',
'capabilities.v1.json':'capabilities.v1.schema.json',
}
for fname, sname in pairs.items():
    item=load_json(FIXTURES / fname)
    schema=name2schema.get(sname)
    if item is None or schema is None:continue
    try: Draft202012Validator(schema,format_checker=FormatChecker()).validate(item)
    except Exception as e: error(f'Golden fixture rejected {fname}: {e}')

for fname in ['job-submit.missing-asset.v1.json','job-submit.unsupported-task.v1.json']:
    item=load_json(FIXTURES / fname)
    if item is None: continue
    try: Draft202012Validator(name2schema['job-submit.v1.schema.json']).validate(item)
    except ValidationError: pass
    except Exception as e: error(f'Unexpected negative fixture validator failure {fname}: {e}')
    else: error(f'Negative fixture incorrectly accepted {fname}')

try:
    openapi=yaml.safe_load((SCHEMAS/'openapi.phase3.candidate.yaml').read_text(encoding='utf-8'))
    if openapi.get('openapi') != '3.1.0': error('Unexpected OpenAPI declared version')
    allcomponents=openapi.get('components',{}).get('schemas',{})
    if not openapi.get('paths'):error('OpenAPI has no paths')
    for name,contract in allcomponents.items():
        Draft202012Validator.check_schema(contract)
    for path,verbs in openapi.get('paths',{}).items():
        for method,route in verbs.items():
            if not route.get('responses'):error(f'{method} {path} lacks responses')
            if not route.get('operationId'):error(f'{method} {path} lacks operationId')
    def check_ref(node, context):
        if isinstance(node,list):
            for i,ch in enumerate(node):check_ref(ch,f'{context}[{i}]')
        if isinstance(node,dict):
            if '$ref' in node:
                ref=node['$ref']
                if not ref.startswith('#/components/schemas/') or ref.split('/')[-1] not in allcomponents:
                    error(f'Unresolved OpenAPI $ref {context} -> {ref}')
            for k,ch in node.items():check_ref(ch,f'{context}/{k}')
    check_ref(openapi,'openapi')
except Exception as e: error(f'OpenAPI failed parse/validate: {e}')

try:
    with (ROOT/'backlog.csv').open(encoding='utf-8',newline='') as f: rows=list(csv.DictReader(f))
    if len(rows)!=40:error(f'Expected 40 backlog tickets, got {len(rows)}')
    ids={x['id'] for x in rows}
    for x in rows:
        if not x['acceptance_criterion']:error(f'{x["id"]} no acceptance')
        for d in x['depends_on'].split(';'):
            if d == '-':continue
            if 'VLSDK-'+d not in ids:error(f'{x["id"]} bad dependency {d}')
    for code in range(1,13):
        p=ROOT/'specs'/f'VLSDK-{code:03d}.md'
        if not p.exists():error(f'Missing ticket expanded spec {p.name}')
except Exception as e:error(f'Backlog parse failed: {e}')

# SHA256 pack manifest not self-including
manifestpath=ROOT/'MANIFEST-PHASE-III.sha256'
if not manifestpath.is_file():error('Missing Phase III SHA manifest')
else:
    for line in manifestpath.read_text(encoding='utf-8').splitlines():
        try: expected,rel=line.split('  ',1)
        except Exception:error(f'Malformed manifest row: {line}');continue
        p=ROOT/rel
        if not p.is_file():error(f'Missing file in manifest {rel}');continue
        actual=hashlib.sha256(p.read_bytes()).hexdigest()
        if expected != actual:error(f'Manifest checksum mismatch {rel}')
    listed={line.split('  ',1)[1] for line in manifestpath.read_text(encoding='utf-8').splitlines() if '  ' in line}
    current={str(p.relative_to(ROOT)) for p in ROOT.rglob('*') if p.is_file() and p.name!='MANIFEST-PHASE-III.sha256'}
    if listed!=current:error(f'Manifest content mismatch missing={sorted(current-listed)}, extra={sorted(listed-current)}')

# Relative Markdown links must resolve; URLs, empty fragments and mailto are excluded.
for p in ROOT.rglob('*.md'):
    contents=p.read_text(encoding='utf-8')
    for link in re.findall(r'\]\(([^)]+)\)',contents):
        if link.startswith(('https://','http://','mailto:','#','data:','sandbox:')):continue
        target=link.split('#')[0]
        if target and not (p.parent/target).exists():error(f'Broken Markdown link {p.relative_to(ROOT)} -> {target}')

# Check runnable Python example syntax without importing candidate modules.
import ast
for p in (ROOT/'examples').glob('*.py'):
    try: ast.parse(p.read_text(encoding='utf-8'))
    except SyntaxError as e:error(f'Invalid Python example {p.name}: {e}')
print(f'Phase III candidate: files={len(list(ROOT.rglob("*")))} schemas={len(name2schema)} fixtures={len(pairs)+2} tickets={len(rows) if "rows" in locals() else 0} errors={len(ERRORS)}')
for e in ERRORS:print('ERROR:',e)
sys.exit(1 if ERRORS else 0)
