#!/usr/bin/env python3
"""Pack an installed conda R environment as the app's runtime payload.

  make_payload.py <env-dir> <baked-prefix> <platform> <arch> <r-version> <out-dir>

Writes <out-dir>/runtime.tar.gz and <out-dir>/runtime.json. main.js reads
runtime.json to know where the archive has to be unpacked (the prefix the
environment was built for) and whether the unpacked copy is current.
"""
import datetime
import hashlib
import json
import os
import subprocess
import sys

env, prefix, platform, arch, rver, out = sys.argv[1:7]
os.makedirs(out, exist_ok=True)
archive = os.path.join(out, "runtime.tar.gz")

# Not needed to run R code: C headers, static libraries, manuals, introspection data.
# conda-meta stays in: it records exactly which packages and versions the runtime is made of.
excludes = ["./include", "./share/doc", "./share/man", "./share/info", "./share/gir-1.0", "./share/gtk-doc",
            "./lib/cmake", "./lib/pkgconfig", "./lib/R/include", "./CACHEDIR.TAG", "*.a",
            "./lib/R/.astrosharp-checked"]
subprocess.run(
    ["tar", "-C", env, "--owner=0", "--group=0", "--numeric-owner", "--sort=name"]
    + [f"--exclude={e}" for e in excludes] + ["-czf", archive, "."],
    check=True)

digest = hashlib.sha256()
with open(archive, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        digest.update(chunk)

info = {
    "id": f"r-{rver}-{platform}-{arch}-{digest.hexdigest()[:12]}",
    "prefix": prefix,
    "r": rver,
    "platform": platform,   # as in Node's process.platform
    "arch": arch,           # as in Node's process.arch
    "bytes": os.path.getsize(archive),
    "build": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
}
with open(os.path.join(out, "runtime.json"), "w") as f:
    json.dump(info, f, indent=2)
print(json.dumps(info))
