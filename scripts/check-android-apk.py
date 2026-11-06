#!/usr/bin/env python3
"""Checks an APK for a read of a Compose $stable field that its class doesn't declare, which crashes
the screen that reads it (NoSuchFieldError). The Compose compiler emits such a read when an inner
class (Prefs.Pref) is a composable's parameter, and R8 removed it in some builds but not in 0.2.17.

    scripts/check-android-apk.py dist/Bento-X.Y.Z.apk

Needs dexdump (Android build-tools) on PATH.
"""
import re
import subprocess
import sys
import tempfile
import zipfile


def main(apk: str) -> int:
    declared, reads = set(), {}
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(apk) as z:
        for name in sorted(n for n in z.namelist() if re.fullmatch(r"classes\d*\.dex", n)):
            path = z.extract(name, tmp)
            out = subprocess.run(["dexdump", "-d", path], capture_output=True, text=True, errors="replace", check=True).stdout
            cls, static = None, False
            for line in out.splitlines():
                if m := re.match(r"\s*Class descriptor\s*:\s*'(L[^']+;)'", line):
                    cls, static = m.group(1), False
                elif "Static fields" in line:
                    static = True
                elif "Instance fields" in line or "Direct methods" in line:
                    static = False
                elif static and cls and re.match(r"\s*name\s*:\s*'\$stable'", line):
                    declared.add(cls)
                for owner in re.findall(r"\bsget\S* \S+, (L[^;]+;)\.\$stable:I", line):
                    reads[owner] = reads.get(owner, 0) + 1
    missing = sorted(c for c in reads if c not in declared)
    if missing:
        print(f"{apk}: reads $stable on classes that don't declare it: {', '.join(missing)}", file=sys.stderr)
        return 1
    print(f"{apk}: {sum(reads.values())} $stable reads, all declared")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
