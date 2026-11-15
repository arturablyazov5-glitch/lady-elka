"""Read-only snapshot verification; patch applies only to an owned temporary copy."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
def digest(data):
    return hashlib.sha256(data).hexdigest()
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)
def tree(folder):
    result = {}
    for p in sorted(folder.rglob('*')):
        assert not p.is_symlink(), f'Symlink: {p}'
        if p.is_file():
            result[p.relative_to(folder).as_posix()] = p.read_bytes()
    return result

m = json.loads((HERE/'manifest.json').read_text())
review = json.loads((HERE/'independent-review-result.json').read_text())
p = json.loads((HERE/'provenance.json').read_text())
assert digest((HERE/'manifest.json').read_bytes()) == p['manifestSHA256']
assert digest((HERE/'independent-review-result.json').read_bytes()) == p['independentReviewSHA256']
assert digest((HERE/'baseline-to-blog-only.patch').read_bytes()) == m['patch']['sha256'] == p['patchSHA256']
assert m['baselineSHA'] == review['baselineSHA'] == p['baselineSHA'] == '40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9'
files = tree(HERE/'source/app/public')
assert {k: digest(v) for k,v in files.items()} == {f['path']:f['sha256'] for f in m['files']} == review['hashes']
assert all(len(files[f['path']]) == f['bytes'] for f in m['files'])
assert set(tree(HERE/'source')) == {'app/public/'+k for k in files} | {'.github/workflows/pages.yml'}
baseline = {}
for row in git('ls-tree','-r',m['baselineSHA'],'--','app/public').decode().splitlines():
    metadata, full = row.split('\t'); mode, kind, blob = metadata.split()
    assert mode == '100644' and kind == 'blob'
    rel = full.removeprefix('app/public/')
    b = git('show',m['baselineSHA']+':'+full)
    baseline[rel] = b
    entry = next(x for x in m['baseline'] if x['path'] == rel)
    assert entry['blobSHA'] == blob and entry['sha256'] == digest(b)
allowed = {'index.html','js/app.js','css/blog.css','js/blog.js','js/blog-model.js','js/blog-rich-editor.js'}
delta = {k for k,v in files.items() if baseline.get(k) != v} | (set(baseline)-set(files))
assert delta == allowed == {f['path'] for f in m['delta']} == set(review['delta'])
assert len(baseline) == 28 and len(files) == 32
assert sum(files.get(k) == v for k,v in baseline.items()) == 26
for f in m['delta']:
    assert f['baselineSHA256'] == (digest(baseline[f['path']]) if f['path'] in baseline else None)
for rel in ['css/payment.css','js/payment.js','js/profile.js','assets/bank_card.svg','assets/sbp-full.svg']:
    assert files[rel] == baseline[rel]
assert b'.payment-success-card' in files['css/payment.css']
assert b'payment-success-page' not in files['index.html'] and b'pro-ticket' not in files['index.html']
app = files['js/app.js'].decode().replace("['catalog','blog','orders'", "['catalog','orders'").replace("${{blog:'Блог',profile:","${{profile:")
assert app.encode() == baseline['js/app.js']
workflow = git('show',m['baselineSHA']+':.github/workflows/pages.yml')
assert (HERE/'source/.github/workflows/pages.yml').read_bytes() == workflow
assert digest(workflow) == m['workflowSHA256']
with tempfile.TemporaryDirectory(prefix='elka-snapshot-apply-',dir='/private/tmp') as temporary:
    temp = Path(temporary)
    for rel,b in baseline.items():
        target = temp/'app/public'/rel
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(b)
    for args in [('apply','-p2','--check'),('apply','-p2')]:
        subprocess.run(['git',*args,str(HERE/'baseline-to-blog-only.patch')],cwd=temp,check=True)
    assert tree(temp/'app/public') == files
print('PASS: 32 reviewed files; 26 unchanged; six blog changes; payment preserved; exact-baseline patch applies')
