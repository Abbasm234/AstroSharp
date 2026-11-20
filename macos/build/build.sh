#!/bin/bash
# Builds AstroSharp.app for macOS on Apple silicon.
#
# Runs on Linux x86_64 (no Mac needed): bash macos/build/build.sh
# See ../README.md for what it needs installed and for what each step is about.
# Result:
#
#   $WORK/out/AstroSharp-darwin-arm64/AstroSharp.app
#
# Environment variables:
#   WORK         scratch directory (default: ./work next to this script), ~3 GB
#   RCODESIGN    path to rcodesign (default: found on PATH)
#   CONDA_CACHE  conda package cache to reuse between builds (optional)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MACOS="$(dirname "$HERE")"
REPO="$(dirname "$MACOS")"
WORK="${WORK:-$HERE/work}"
export RCODESIGN="${RCODESIGN:-rcodesign}"

# The R runtime is built for this exact location on the Mac; main.js unpacks it
# there on first launch. A path without spaces that any user can write to.
MAC_PREFIX=/Users/Shared/AstroSharp/runtime
MAC_R_PLATFORM=aarch64-apple-darwin20.0.0

step() { printf '\n=== %s\n' "$*"; }
die()  { echo "build.sh: $*" >&2; exit 1; }

python3 -c 'import rattler, ziglang' 2>/dev/null || die "need: pip install py-rattler ziglang"
command -v node >/dev/null || die "need Node.js"
"$RCODESIGN" --version >/dev/null 2>&1 || die "need rcodesign (set RCODESIGN or put it on PATH)"
[ -x /usr/bin/codesign ] || die "install the codesign stand-in first: sudo install -m 755 '$HERE/codesign-shim.sh' /usr/bin/codesign"
[ -d "$HERE/node_modules/@electron/packager" ] || (cd "$HERE" && npm install --no-audit --no-fund)

mkdir -p "$WORK"
CACHE_ARGS=()
[ -n "${CONDA_CACHE:-}" ] && CACHE_ARGS=(--cache "$CONDA_CACHE")

step "1/6 R runtime for the Mac (conda-forge, osx-arm64)"
python3 "$HERE/conda_env.py" osx-arm64 "$WORK/rt-mac" --prefix "$MAC_PREFIX" --runtime \
  --lock "$WORK/osx-arm64.lock.json" ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"}

step "2/6 The same R for this machine, to install R-level package files"
python3 "$HERE/conda_env.py" linux-64 "$WORK/r-linux" --extra r-tiff r-imager r-readbitmap ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"}
RL="$WORK/r-linux"
RLIB="$RL/lib/R/library"
r_mac=$(sed -n 's/^Version: //p' "$WORK/rt-mac/lib/R/library/base/DESCRIPTION")
r_linux=$(sed -n 's/^Version: //p' "$RLIB/base/DESCRIPTION")
[ "$r_mac" = "$r_linux" ] || die "R versions differ between the two environments ($r_mac vs $r_linux)"

step "3/6 Cross-compile tiff and imager for macOS arm64"
mkdir -p "$WORK/src"
for pkg in tiff imager; do
  ver=$(sed -n 's/^Version: //p' "$RLIB/$pkg/DESCRIPTION")
  if [ ! -d "$WORK/src/$pkg-$ver" ]; then
    git clone -q --depth 1 --branch "$ver" "https://github.com/cran/$pkg.git" "$WORK/src/$pkg-$ver"
  fi
  ln -sfn "$pkg-$ver" "$WORK/src/$pkg"
done
bash "$HERE/cross_compile.sh" "$WORK/rt-mac" "$WORK/src/tiff" "$WORK/src/imager" "$WORK/cross"

step "4/6 Add the packages conda-forge lacks for osx-arm64"
STAGE="$WORK/stage-pkgs"
mkdir -p "$STAGE"
# Plain R code, so what the Linux R installs is usable on the Mac as it is.
"$RL/bin/R" CMD INSTALL --no-docs -l "$STAGE" "$MACOS/app/r/pkgs/neuralnet_1.44.6.tar.gz"
"$RL/bin/R" CMD INSTALL --no-docs -l "$STAGE" "$HERE/waveslim-placeholder"
# R-level files from the Linux builds of the same versions, native library swapped.
for pkg in tiff imager readbitmap; do
  mkdir -p "$STAGE/$pkg"
  cp -a "$RLIB/$pkg/." "$STAGE/$pkg/"
done
install -m 755 "$WORK/cross/tiff.so" "$STAGE/tiff/libs/tiff.so"
install -m 755 "$WORK/cross/imager.so" "$STAGE/imager/libs/imager.so"
"$RL/bin/Rscript" -e '
  args <- commandArgs(TRUE); stage <- args[1]; platform <- args[2]
  for (p in c("tiff", "imager")) {
    d <- file.path(stage, p)
    m <- readRDS(file.path(d, "Meta", "package.rds")); old <- m$Built$Platform
    m$Built$Platform <- platform; saveRDS(m, file.path(d, "Meta", "package.rds"))
    x <- readLines(file.path(d, "DESCRIPTION")); writeLines(sub(old, platform, x, fixed = TRUE), file.path(d, "DESCRIPTION"))
  }' "$STAGE" "$MAC_R_PLATFORM"
cp -a "$STAGE/." "$WORK/rt-mac/lib/R/library/"
"$RL/bin/Rscript" -e '
  lib <- commandArgs(TRUE)[1]; ip <- installed.packages(lib.loc = lib)
  req <- c("shiny","shinycssloaders","neuralnet","dplyr","ggthemes","tiff","htmltools","reshape2","waveslim",
           "imager","bslib","foreach","doParallel","doSNOW","shinyWidgets","ragg","later")
  deps <- tools::package_dependencies(req, db = ip, recursive = TRUE, which = c("Depends","Imports","LinkingTo"))
  miss <- setdiff(unique(c(req, unlist(deps))), rownames(ip))
  if (length(miss)) stop("missing from the Mac R library: ", paste(miss, collapse = ", "))
  stopifnot(ip["neuralnet", "Version"] == "1.44.6")
  cat(nrow(ip), "packages in the Mac R library; nothing missing\n")' "$WORK/rt-mac/lib/R/library"

step "5/6 Pack the runtime"
python3 "$HERE/make_payload.py" "$WORK/rt-mac" "$MAC_PREFIX" darwin arm64 "$r_mac" "$WORK/payload"

step "6/6 Assemble, package and sign the app"
APP="$WORK/app"
rm -rf "${WORK:?}/app" "${WORK:?}/out"
mkdir -p "$APP/shiny/PSF" "$APP/runtime"
cp -a "$MACOS/app/." "$APP/"
cp "$REPO/LICENSE" "$APP/LICENSE"
# Only what app.R loads; the other app*.R variants and model folders are not used.
S="$REPO/resources/app"
cp "$S/app.R" "$S/GetMatrixFun9x9.R" "$S/GetMatrixFun.R" "$S/First3BetasFun.R" "$S/First3BetasFunMultiCore.R" \
   "$S/Combined_Sharpen_and_Clean.R" "$S/Combined_Sharpen_and_Clean_Multicore.R" \
   "$S/DualPSF.R" "$S/DualPSF_Multicore.R" "$S/StarMask.R" "$S"/*.RDS "$S"/*.tif "$APP/shiny/"
cp "$S"/PSF/*.RDS "$APP/shiny/PSF/"
cp "$WORK/payload/runtime.tar.gz" "$WORK/payload/runtime.json" "$APP/runtime/"

(cd "$HERE" && node package.js "$APP" "$WORK/out" "$HERE/AstroSharp.icns")
OUT="$WORK/out/AstroSharp-darwin-arm64"
cp "$OUT/LICENSE" "$OUT/AstroSharp.app/Contents/Resources/LICENSE.electron.txt"
cp "$OUT/LICENSES.chromium.html" "$OUT/AstroSharp.app/Contents/Resources/LICENSES.chromium.html"
# Ad-hoc signature over the finished bundle (Apple silicon will not start unsigned code).
"$RCODESIGN" sign "$OUT/AstroSharp.app" >/dev/null 2>&1
chmod -R u+rwX,go+rX "$OUT/AstroSharp.app"

echo
echo "Built $OUT/AstroSharp.app ($(du -sh "$OUT/AstroSharp.app" | cut -f1))"
echo "Copy it to a Mac with its symlinks and permissions intact, for example:"
echo "  tar -czf AstroSharp-macos-arm64.tar.gz -C '$OUT' AstroSharp.app"
