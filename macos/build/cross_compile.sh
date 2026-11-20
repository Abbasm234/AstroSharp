#!/bin/bash
# Cross-compile the native code of the R packages tiff and imager for macOS arm64.
#
# conda-forge has no osx-arm64 build of either package, so their shared
# libraries are built here with zig's clang (which can target macOS from any
# OS) and linked against the libraries of the macOS conda environment.
#
#   cross_compile.sh <mac-env> <tiff-source> <imager-source> <out-dir>
#
# Requires: pip install ziglang
set -euo pipefail
ENV=$1; TIFF_SRC=$2; IMAGER_SRC=$3; OUT=$4

ZCC="python3 -m ziglang cc"
ZCXX="python3 -m ziglang c++"
TARGET="-target aarch64-macos.11.0"
RINC="$ENV/lib/R/include"; ENVINC="$ENV/include"; ENVLIB="$ENV/lib"; RLIB="$ENV/lib/R/lib"
mkdir -p "$OUT"

# Same shape as the package libraries conda-forge builds: a dylib named
# <pkg>.so that finds libR and the environment's libraries through @rpath.
link_flags() {
  echo "-dynamiclib -undefined dynamic_lookup -Wl,-headerpad_max_install_names" \
       "-install_name @rpath/R/library/$1/libs/$1.so" \
       "-Wl,-rpath,@loader_path/../../../lib/ -Wl,-rpath,@loader_path/../../../../"
}

echo "== tiff"
T=$(mktemp -d)
cp "$TIFF_SRC"/src/*.c "$TIFF_SRC"/src/*.h "$T"/
for f in "$T"/*.c; do
  $ZCC $TARGET -O2 -fPIC -DNDEBUG -DHAVE_UNISTD_H=1 -I"$RINC" -I"$ENVINC" -c "$f" -o "${f%.c}.o"
done
# shellcheck disable=SC2046
$ZCC $TARGET $(link_flags tiff) -o "$OUT/tiff.so" "$T"/*.o -L"$ENVLIB" -ltiff -ljpeg -L"$RLIB" -lR

echo "== imager (one large C++ unit; this takes a couple of minutes)"
I=$(mktemp -d)
mkdir -p "$I/src" "$I/inst"
cp "$IMAGER_SRC"/src/*.cpp "$IMAGER_SRC"/src/*.h "$I/src/"
cp -r "$IMAGER_SRC/inst/include" "$I/inst/include"
# Flags follow imager's src/Makevars.in. Two deliberate differences:
#   -Dcimg_display=0   no X11 display window, so the app does not need XQuartz
#   no -fopenmp        CImg falls back to its serial code paths
( cd "$I/src" && $ZCXX $TARGET -std=gnu++17 -O2 -fPIC -fvisibility-inlines-hidden -DNDEBUG \
    -I"$RINC" -I"$ENV/lib/R/library/Rcpp/include" -I"$ENVINC" -I../inst/include \
    -Dcimg_display=0 -Dcimg_use_fftw3 -Dcimg_use_tiff \
    -DCIMG_COMPILING -Dcimg_use_rng -Dcimg_use_r -Dcimg_use_fftw3_singlethread -Dcimg_verbosity=1 \
    -Dcimg_date='""' -Dcimg_time='""' \
    -c unity.cpp -o unity.o )
# shellcheck disable=SC2046
$ZCXX $TARGET $(link_flags imager) -o "$OUT/imager.so" "$I/src/unity.o" -L"$ENVLIB" -lfftw3 -ltiff -L"$RLIB" -lR

ls -la "$OUT"
