from pathlib import Path
import json,hashlib
root=Path(__file__).resolve().parent.parent
files=[]
for p in sorted(root.rglob('*')):
 r=p.relative_to(root)
 if any(x in r.parts for x in ['node_modules','private-operator','.git','evidence','runtime']): continue
 if p.is_symlink(): continue
 if not p.is_file() or str(r) in ['RELEASE-MANIFEST.json','test-results.tap','demo-result.json']: continue
 files.append({'path':str(r),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
b=(json.dumps({'format':'mote-release-files-v1','files':files},indent=2)+'\n').encode()
(root/'RELEASE-MANIFEST.json').write_bytes(b)
print(json.dumps({'files':len(files),'sha256':hashlib.sha256(b).hexdigest()}))
