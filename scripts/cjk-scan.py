#!/usr/bin/env python3
r"""Count CJK characters per file in a repository tree.

Gate for the English-only rule: the only file allowed to report a non-zero
count is the i18n payload (src/desktop/i18n/zh.ts). Escaped device names
(\uXXXX in JSON/Python, \u{XXXX} in Swift) do not count, because the source
text itself is ASCII.

Usage:
  python3 cjk-scan.py <root> [--allow REL]... [--show N]

Exit code: 0 when the only files with CJK are the allowed ones, 1 otherwise
(the default allow-list is the i18n payload, src/desktop/i18n/zh.ts).
Skips binaries, .git and node_modules; reports one line per file plus a total,
sorted by count descending so the worst offender is on top.
"""
import os
import sys

CJK = ((0x3000, 0x303F), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
       (0xF900, 0xFAFF), (0xFF00, 0xFFEF))
SKIP_DIRS = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv'}
SKIP_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
            '.gz', '.tgz', '.xz', '.onnx', '.wav', '.mp3', '.mp4', '.mov',
            '.bin', '.dylib', '.so', '.o', '.a', '.woff', '.woff2', '.ttf'}
# Files whose name says "binary, do not read" regardless of extension.
BINARY_HINTS = ('atvv-link',)


def is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK)


def scan(root: str):
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in SKIP_EXT:
                continue
            if name in BINARY_HINTS:
                continue
            path = os.path.join(dirpath, name)
            try:
                if os.path.getsize(path) > 4 * 1024 * 1024:
                    continue
                with open(path, 'r', encoding='utf-8') as fh:
                    text = fh.read()
            except (UnicodeDecodeError, OSError):
                continue
            count = sum(1 for ch in text if is_cjk(ch))
            if count:
                rows.append((count, text.count('\n') + 1, os.path.relpath(path, root)))
    rows.sort(reverse=True)
    return rows


def main() -> int:
    args = [a for a in sys.argv[1:]]
    show = 0
    if '--show' in args:
        i = args.index('--show')
        show = int(args[i + 1])
        del args[i:i + 2]
    allowed = []
    while '--allow' in args:
        i = args.index('--allow')
        allowed.append(os.path.normpath(args[i + 1]))
        del args[i:i + 2]
    if not allowed:
        allowed = [os.path.normpath('src/desktop/i18n/zh.ts')]
    root = args[0] if args else '.'
    rows = scan(root)
    for count, lines, rel in rows:
        print(f'{count:6d} {lines:5d}L {rel}')
    total = sum(r[0] for r in rows)
    print(f'--- {len(rows)} file(s), {total} CJK char(s)')
    if show and rows:
        worst = os.path.join(root, rows[0][2])
        with open(worst, 'r', encoding='utf-8') as fh:
            for n, line in enumerate(fh, 1):
                if any(is_cjk(ch) for ch in line):
                    print(f'{n}: {line.rstrip()}')
                    show -= 1
                    if show <= 0:
                        break
    unexpected = [rel for _, _, rel in rows if os.path.normpath(rel) not in allowed]
    if unexpected:
        print('Outside the allow-list: ' + ', '.join(unexpected))
        return 1
    print('Only the allow-listed i18n payload has CJK.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
