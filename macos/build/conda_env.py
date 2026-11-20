#!/usr/bin/env python3
"""Solve and install the conda-forge R environment that AstroSharp runs on.

Used twice by build.sh:

  * for osx-arm64, to produce the R runtime that ships inside AstroSharp.app.
    It is installed on the build machine (Linux is fine) but with the Mac
    location baked in (--prefix), and without the compiler toolchain that
    r-base depends on (--runtime);

  * for the build machine's own platform, to get an R of the same version that
    can install the R-level parts of packages.

Requires: pip install py-rattler
"""
import argparse
import asyncio
import json
import re

import rattler
from rattler import BuildString, GenericVirtualPackage, PackageName, Version, install, solve

# What app.R and the files it sources attach, plus what tiff and imager need to
# build and load. tiff, imager and waveslim themselves are not on conda-forge
# for osx-arm64; build.sh adds them.
SPECS = [
    "r-base=4.5",
    "r-shiny", "r-shinycssloaders", "r-shinywidgets", "r-bslib", "r-htmltools",
    "r-dplyr", "r-reshape2", "r-ggthemes", "r-ragg", "r-later",
    "r-foreach", "r-doparallel", "r-dosnow", "r-snow",
    "r-deriv", "r-mass",                      # neuralnet's dependencies
    "r-rcpp", "r-magrittr", "r-stringr", "r-png", "r-jpeg", "r-bmp",
    "r-purrr", "r-downloader", "r-igraph",    # imager's dependencies
    "fftw", "libtiff",
]

# Packages r-base pulls in so that R can compile packages. Nothing in them is
# needed to run R code, and they are most of the download.
TOOLCHAIN = re.compile(
    r"^(clang.*|clangxx.*|cctools.*|ld64.*|llvm-tools.*|libllvm.*|libclang.*|compiler-rt.*|libcompiler-rt"
    r"|gcc_impl.*|gxx_impl.*|gfortran_impl.*|libgcc-devel.*|libstdcxx-devel.*|tapi|sigtool.*|libsigtool"
    r"|sdkroot.*|libcxx-devel|libcxx-headers|make)$"
)


def virtual_packages(platform):
    def vp(name, version, build="0"):
        return GenericVirtualPackage(PackageName(name), Version(version), BuildString(build))

    if platform.startswith("osx"):
        return [vp("__osx", "13.0"), vp("__unix", "0"), vp("__archspec", "1", "m1")]
    return [vp("__linux", "5.10"), vp("__glibc", "2.35"), vp("__unix", "0"), vp("__archspec", "1", "x86_64")]


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("platform", help="conda platform, e.g. osx-arm64 or linux-64")
    ap.add_argument("target", help="directory to install the environment into")
    ap.add_argument("--prefix", help="location to bake into the files instead of TARGET (where it will live on the Mac)")
    ap.add_argument("--runtime", action="store_true", help="leave out the compiler toolchain packages")
    ap.add_argument("--extra", nargs="*", default=[], help="additional package specs")
    ap.add_argument("--cache", default=None, help="package cache directory")
    ap.add_argument("--lock", help="write the list of installed packages to this JSON file")
    args = ap.parse_args()

    records = await solve(
        sources=["conda-forge"],
        specs=SPECS + args.extra,
        platforms=[args.platform, "noarch"],
        virtual_packages=virtual_packages(args.platform),
    )
    if args.runtime:
        records = [r for r in records if not TOOLCHAIN.match(r.name.normalized)]
    r_version = next(str(r.version) for r in records if r.name.normalized == "r-base")
    print(f"{args.platform}: {len(records)} packages, R {r_version}, "
          f"{sum((r.size or 0) for r in records) / 1e6:.0f} MB to download")

    extra = {"alternative_target_prefix": args.prefix} if args.prefix else {}
    if args.cache:
        extra["cache_dir"] = args.cache
    await install(
        records,
        target_prefix=args.target,
        platform=rattler.platform.Platform(args.platform),
        execute_link_scripts=False,
        show_progress=False,
        **extra,
    )
    if args.lock:
        with open(args.lock, "w") as f:
            json.dump(
                [{"name": r.name.normalized, "version": str(r.version), "build": str(r.build),
                  "subdir": str(r.subdir), "url": str(r.url)} for r in sorted(records, key=lambda r: r.name.normalized)],
                f, indent=1)
    print(f"installed into {args.target}")


if __name__ == "__main__":
    asyncio.run(main())
