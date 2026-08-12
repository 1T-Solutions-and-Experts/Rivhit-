#!/usr/bin/env python3
"""
Rivhit Bridge — build script.

Why inlining is MANDATORY: Zoho's widget CDN intermittently 404s shared asset
files, and absolute /app/... paths bypass the versioned prefix entirely. Every
widget must be fully self-contained, so rv-api.js and rv-styles.css are inlined
into each widget at build time. NEVER ship a widget with an external
<script src>/<link> to a bundle-local file.

The build refuses to produce a zip when the tests fail. The pure functions in
rv-api.js carry the financial risk; a red suite means the zip does not exist.

Usage:  python3 build.py
Output: rivhit-bridge-<VERSION>.zip
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

ROOT      = os.path.dirname(os.path.abspath(__file__))
APP       = os.path.join(ROOT, 'app')
FUNCTIONS = os.path.join(ROOT, 'functions')
DIST      = os.path.join(ROOT, 'dist')

VERSION   = 'V1.0-r1'          # bump every deploy; the console proves what loaded
ZIP_NAME  = 'rivhit-bridge-%s.zip' % VERSION

API_REF   = '<script src="../../rv-api.js"></script>'
STYLE_REF = '<link rel="stylesheet" href="../../rv-styles.css">'

# Sigma has no shared Deluge library, so the argument-extraction prologue is
# copy-pasted into every REST function. Keeping it identical is what makes that
# tolerable, so the build asserts it rather than trusting discipline.
PROLOGUE_MARKERS = [
    'crmAPIRequest.get("body")',
    'crmAPIRequest.get("params")',
    'crmAPIRequest.get("arguments")',
]
# Exempt for two different reasons:
#  - rv_reconcile / rv_log_change take no crmAPIRequest at all (scheduled and
#    workflow-triggered respectively);
#  - the IPN endpoints receive form-encoded POSTs from iCredit, not the widget's
#    {arguments: "..."} wrapper, so they parse the raw body instead.
PROLOGUE_EXEMPT = {
    'rv_reconcile.deluge',
    'rv_log_change.deluge',
    'rv_icredit_ipn.deluge',
    'rv_icredit_ipn_failure.deluge',
}


def fail(msg):
    print('\n❌ BUILD FAILED: ' + msg)
    sys.exit(1)


def ok(msg):
    print('  ✓ ' + msg)


def check_node():
    r = subprocess.run(['node', '--version'], capture_output=True, text=True)
    if r.returncode != 0:
        fail('node is required for syntax checks and tests')
    return r.stdout.strip()


def main():
    print('Rivhit Bridge build %s' % VERSION)
    print('-' * 52)

    # ── 1. Sources ──────────────────────────────────────────────────────
    print('[1/6] validating sources')
    node_ver = check_node()
    ok('node %s' % node_ver)

    api_path = os.path.join(APP, 'rv-api.js')
    css_path = os.path.join(APP, 'rv-styles.css')
    man_path = os.path.join(APP, 'plugin-manifest.json')
    for p in (api_path, css_path, man_path):
        if not os.path.isfile(p):
            fail('missing %s' % os.path.relpath(p, ROOT))

    r = subprocess.run(['node', '--check', api_path], capture_output=True, text=True)
    if r.returncode != 0:
        fail('rv-api.js syntax error:\n' + r.stderr)
    ok('rv-api.js parses')

    try:
        manifest = json.load(open(man_path, encoding='utf-8'))
    except Exception as e:
        fail('plugin-manifest.json is not valid JSON: %s' % e)
    ok('plugin-manifest.json valid')

    api = open(api_path, encoding='utf-8').read()
    css = open(css_path, encoding='utf-8').read()
    if VERSION not in api:
        fail('rv-api.js does not carry the %s build marker' % VERSION)
    ok('build marker present')

    # Every widget the manifest declares must exist, and vice versa.
    declared = set()
    for w in manifest.get('ui', {}).get('widgets', []):
        declared.add(w['url'])
        wp = os.path.join(ROOT, w['url'])
        if not os.path.isfile(wp):
            fail('manifest declares %s but the file is missing' % w['url'])
    on_disk = set(
        os.path.relpath(p, ROOT).replace(os.sep, '/')
        for p in glob.glob(os.path.join(APP, 'widgets', '*', 'index.html'))
    )
    orphans = on_disk - declared
    if orphans:
        fail('widget(s) on disk but not in the manifest: %s' % ', '.join(sorted(orphans)))
    ok('%d widget registrations resolve' % len(declared))

    # ── 2. Deluge hygiene ───────────────────────────────────────────────
    print('[2/6] checking Deluge bodies')
    deluge = sorted(glob.glob(os.path.join(FUNCTIONS, '*.deluge')))
    if not deluge:
        fail('no Deluge functions found')
    for p in deluge:
        name = os.path.basename(p)
        body = open(p, encoding='utf-8').read()
        # A signature line in the body is a syntax error — Sigma writes the wrapper.
        for line in body.splitlines():
            s = line.strip()
            if re.match(r'^(string|void|int|bool|map|list)\s+\w+\s*\(', s):
                fail('%s contains a signature line ("%s") — paste the BODY ONLY' % (name, s[:60]))
        if 'return ' not in body:
            fail('%s has no return statement; every function needs a guaranteed top-level return' % name)
        if 'addAll' in body:
            fail('%s uses addAll, which is unreliable on this platform' % name)
        if name not in PROLOGUE_EXEMPT:
            for marker in PROLOGUE_MARKERS:
                if marker not in body:
                    fail('%s is missing the argument-extraction prologue (%s). '
                         'Which location is populated varies by platform version.' % (name, marker))
        # The dry run must never carry the idempotency key (design review C1):
        # if Rivhit registers request_reference during validation, the real call
        # is refused as a duplicate and no document is ever created.
        # Inspect statements only — the prose above these bodies says the same
        # thing in words and would otherwise trip the check.
        code = '\n'.join(
            l for l in body.splitlines()
            if not l.lstrip().startswith('//')
        )
        if 'put("check_only",true)' in code:
            after = code.split('put("check_only",true)', 1)[1]
            dry_region = after.split('remove("check_only")', 1)[0]
            for forbidden in ('put("request_reference"', 'put("prevent_duplicates"'):
                if forbidden in dry_region:
                    fail('%s sets %s before clearing check_only — a dry run that registers the '
                         'idempotency key makes the real call get refused as a duplicate '
                         '(design review C1)' % (name, forbidden))
            if 'remove("check_only")' not in code:
                fail('%s sets check_only but never removes it — the real call would also be a '
                     'dry run and no document would be created' % name)
    ok('%d Deluge bodies pass hygiene checks' % len(deluge))

    # ── 3. Tests ────────────────────────────────────────────────────────
    print('[3/6] running tests')
    tests = sorted(glob.glob(os.path.join(ROOT, 'tests', '*.test.js')))
    if not tests:
        fail('no tests found — the money logic must not ship untested')
    r = subprocess.run(['node', '--test'] + tests, capture_output=True, text=True)
    if r.returncode != 0:
        print((r.stdout or '')[-3000:])
        print((r.stderr or '')[-800:])
        fail('tests are red — nothing gets zipped')
    summary = ', '.join(
        l.strip('# ').strip() for l in r.stdout.splitlines()
        if l.startswith(('# tests', '# pass', '# fail'))
    )
    ok('tests green (%s)' % summary)

    # ── 4. Inline ───────────────────────────────────────────────────────
    print('[4/6] inlining shared assets')
    shutil.rmtree(DIST, ignore_errors=True)
    shutil.copytree(APP, os.path.join(DIST, 'app'),
                    ignore=shutil.ignore_patterns('.DS_Store', 'rv-api.js', 'rv-styles.css'))
    widgets_dir = os.path.join(DIST, 'app', 'widgets')
    for w in sorted(os.listdir(widgets_dir)):
        p = os.path.join(widgets_dir, w, 'index.html')
        if not os.path.isfile(p):
            continue
        html = open(p, encoding='utf-8').read()
        if API_REF not in html:
            fail('widget %s does not reference rv-api.js in the expected form' % w)
        if STYLE_REF not in html:
            fail('widget %s does not reference rv-styles.css in the expected form' % w)
        html = html.replace(API_REF, '<script>\n/* inlined rv-api.js */\n' + api + '\n</script>')
        html = html.replace(STYLE_REF, '<style>\n/* inlined rv-styles.css */\n' + css + '\n</style>')
        if 'rv-api.js"' in html or 'rv-styles.css"' in html:
            fail('widget %s still references a bundle-local asset after inlining' % w)
        open(p, 'w', encoding='utf-8').write(html)

        blocks = re.findall(r'<script>(.*?)</script>', html, re.S)
        for i, block in enumerate(blocks):
            tmp = os.path.join(DIST, '_chk_%s_%d.js' % (w, i))
            open(tmp, 'w', encoding='utf-8').write(block)
            rr = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
            os.remove(tmp)
            if rr.returncode != 0:
                fail('widget %s inline script #%d has a syntax error:\n%s' % (w, i, rr.stderr))
        ok('%-16s inlined, %d script block(s) checked, %d KB' % (w, len(blocks), len(html) // 1024))

    # ── 5. RTL sanity ───────────────────────────────────────────────────
    print('[5/6] checking RTL setup')
    for w in sorted(os.listdir(widgets_dir)):
        p = os.path.join(widgets_dir, w, 'index.html')
        if not os.path.isfile(p):
            continue
        head = open(p, encoding='utf-8').read(400)
        if 'dir="rtl"' not in head:
            fail('widget %s is not RTL by default — Hebrew is the shipped language' % w)
    ok('every widget opens RTL')

    # ── 6. Zip ──────────────────────────────────────────────────────────
    print('[6/6] packaging')
    zip_path = os.path.join(ROOT, ZIP_NAME)
    if os.path.exists(zip_path):
        os.remove(zip_path)
    r = subprocess.run(['zip', '-r', '-q', zip_path, 'app/', '-x', '*.DS_Store'],
                       cwd=DIST, capture_output=True, text=True)
    if r.returncode != 0:
        fail('zip failed:\n' + r.stderr)
    size_kb = os.path.getsize(zip_path) // 1024
    print('-' * 52)
    print('✅ %s -> %s (%d KB)' % (VERSION, ZIP_NAME, size_kb))
    print('   Upload in Sigma, publish, then confirm the console shows BUILD %s' % VERSION)
    print('   Deluge bodies are NOT in the zip — paste them from functions/ (see docs/SIGMA-DEPLOYMENT.md)')


if __name__ == '__main__':
    main()
