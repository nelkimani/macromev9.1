#!/usr/bin/env python3
"""Run before every upload:  python3 tools/stamp.py

Hashes every app file and writes that hash into sw.js (VERSION) and into the ?v= links in index.html.
Change any file, run this, upload: every device picks the update up. Running it twice changes nothing."""
import hashlib, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def rd(p): return open(os.path.join(ROOT, p), encoding='utf-8').read()
def wr(p, t): open(os.path.join(ROOT, p), 'w', encoding='utf-8', newline='').write(t)

LINK = re.compile(r'((?:css/app\.css|js/[A-Za-z0-9_-]+\.js|icons/logo\.jpg))\?v=[A-Za-z0-9]+')
VER = re.compile(r"const VERSION = 'macrome-[A-Za-z0-9]+';")

h = hashlib.sha256()
files = ['manifest.webmanifest', 'css/app.css', 'icons/logo.jpg'] + sorted(
    'js/' + f for f in os.listdir(os.path.join(ROOT, 'js')) if f.endswith('.js'))
for dirpath, _, names in os.walk(os.path.join(ROOT, 'vendor')):
    files += sorted(os.path.relpath(os.path.join(dirpath, n), ROOT).replace(os.sep, '/') for n in names)
for f in files:
    h.update(f.encode()); h.update(open(os.path.join(ROOT, f), 'rb').read())
h.update(LINK.sub(r'\1', rd('index.html')).encode())          # index.html without the stamps
h.update(VER.sub('', rd('sw.js')).encode())                    # sw.js without the version line
v = h.hexdigest()[:10]

idx = rd('index.html'); new = LINK.sub(lambda m: m.group(1) + '?v=' + v, idx)
sw = rd('sw.js'); assert VER.search(sw), 'VERSION line not found in sw.js'
newsw = VER.sub("const VERSION = 'macrome-%s';" % v, sw)
changed = (new != idx) or (newsw != sw)
wr('index.html', new); wr('sw.js', newsw)
print('version macrome-%s %s' % (v, '(updated)' if changed else '(unchanged)'))
