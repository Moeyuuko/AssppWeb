"""Build readable JS glue and separate WASM from pinned Unicorn.js sources.

The upstream build embeds WASM in a minified JS file. We deliberately link
separate files with debug names and no JS minification. No prebuilt engine is
downloaded. The source archive lets image users audit/rebuild the dependency.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile

source = Path('/build/source')
output = Path('/out')
output.mkdir()
os.chdir(source)
spec = importlib.util.spec_from_file_location('upstream', source / 'build.py')
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)
upstream.patchUnicorn()
subprocess.run(['python3', '/build/prepare-tci.py'], check=True)
upstream.generateConstants()

subprocess.run([
    'emcmake', 'cmake', '-S', 'unicorn', '-B', 'unicorn/build',
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
    '-DUNICORN_ARCH=x86', '-DUNICORN_BUILD_TESTS=OFF',
    '-DUNICORN_INSTALL=OFF', '-DUNICORN_FUZZ=OFF',
    '-DUNICORN_LEGACY_STATIC_ARCHIVE=ON',
], check=True)
subprocess.run([
    'cmake', '--build', 'unicorn/build', '--target', 'unicorn_archive', '-j4',
], check=True)
subprocess.run([
    'emcc', '-O2', '-g2', 'unicorn/build/libunicorn.a',
    '-sEXPORTED_FUNCTIONS=' + json.dumps(upstream.EXPORTED_FUNCTIONS),
    '-sEXPORTED_RUNTIME_METHODS=' + json.dumps([
        'ccall', 'getValue', 'setValue', 'addFunction', 'removeFunction',
        'writeArrayToMemory',
    ]),
    '-sALLOW_TABLE_GROWTH=1', '-sALLOW_MEMORY_GROWTH=1',
    '-sMAXIMUM_MEMORY=1073741824', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
    '-sWASM_BIGINT=1', '-sENVIRONMENT=web,worker,node',
    '--post-js', 'src/constants_x86.js',
    '--post-js', 'src/unicorn-wrapper.js',
    '-o', str(output / 'unicorn.mjs'),
], check=True)

with tarfile.open(output / 'source.tar.gz', 'w:gz') as archive:
    for item in source.rglob('*'):
        relative = item.relative_to(source)
        if '.git' in relative.parts or 'build' in relative.parts:
            continue
        if item.is_file():
            archive.add(item, arcname=str(relative))
    archive.add('/build/build.py', arcname='asspp-build.py')
    archive.add('/build/prepare-tci.py', arcname='prepare-tci.py')
metadata = {
    'unicornJsCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'unicornCommit': subprocess.check_output(['git', '-C', 'unicorn', 'rev-parse', 'HEAD'], text=True).strip(),
    'emscripten': subprocess.check_output(['emcc', '--version'], text=True).splitlines()[0],
}
(output / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
