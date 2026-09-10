"""Use 64-bit virtual TCI registers while retaining wasm32 host pointers.

The interpreter's registers are a C array, so their width need not match the
host pointer width. Keeping x86-64 values in one slot avoids the old TCI
register-pair path and its helper argument/liveness problems. The helper ABI
must change with the interpreter: six uint64 arguments, one uint64 result.
Each replacement is checked against our pinned source and fails on drift.
"""
from pathlib import Path

ROOT = Path('/build/source')


def replace(path, old, new):
    file = ROOT / path
    text = file.read_text()
    if text.count(old) != 1:
        raise ValueError(f'Pinned TCI source changed: {path}')
    file.write_text(text.replace(old, new))


replace('unicorn/qemu/tcg/tci/tcg-target.h',
        '#if UINTPTR_MAX == UINT32_MAX',
        '#if defined(__EMSCRIPTEN__)\n# define TCG_TARGET_REG_BITS 64\n#elif UINTPTR_MAX == UINT32_MAX')

adapter = ROOT / 'unicorn/qemu/include/exec/helper-adapter.h'
text = adapter.read_text()
start = text.index('/* The uniform adapter argument list:')
end = text.index('/* Compile-time dispatch helpers. */')
text = text[:start] + '''/* AssppWeb: six 64-bit virtual argument registers. */
#define GEN_ADAPTER_ARGS uint64_t a1, uint64_t a2, uint64_t a3, uint64_t a4, uint64_t a5, uint64_t a6
#define GEN_ADAPTER_DECLARE(name) uint64_t glue(adapter_helper_, name)(GEN_ADAPTER_ARGS);
#define A1 a1
#define A2 a2
#define A3 a3
#define A4 a4
#define A5 a5
#define A6 a6

''' + text[end:]
adapter.write_text(text)

# The upstream extension loop assumes pairs of adjacent i32 temporaries.
# With 64-bit virtual slots an i32 producer already clears its high half.
tcg = ROOT / 'unicorn/qemu/tcg/tcg.c'
text = tcg.read_text()
start = text.index('    /* Unicorn.js (TCI/WASM adapter ABI):')
end = text.index('    op = tcg_emit_op(tcg_ctx, INDEX_op_call);', start)
text = text[:start] + text[end:]
tcg.write_text(text)
