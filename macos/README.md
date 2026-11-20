# AstroSharp for macOS

Everything needed to build AstroSharp as a Mac app for Apple silicon (M-series) Macs, macOS 13 or newer.

It runs the same `app.R`, the same sourced R files and the same model `.RDS` files as the Windows build in this repository, none of them modified. Like the Windows build, the app carries its own copy of R, so nothing else has to be installed.

The built app is about 450 MB and is not in the repository (two of its files are over GitHub's 100 MB limit). Build it with the steps under [Building](#building); the result can be attached to a release.

## Using the app

1. Open `AstroSharp.app`.
2. The first launch takes a little longer: the app unpacks its copy of R (about 400 MB) into `/Users/Shared/AstroSharp`. No internet connection is needed. Later launches take a few seconds.
3. Use it as on Windows: choose a TIFF, pick a model, press **Update Sliders**, then **Download Processed File**. Closing the window quits the app.

Good to know:

- The app is signed ad hoc, not with an Apple developer certificate. A copy that was downloaded has to be allowed once: right-click the app and choose Open, or use System Settings > Privacy & Security > Open Anyway.
- **Hybrid Model** only produces a result with **Multicore** selected. `app.R` has no single-core branch for it, so this is the same on Windows.
- While R is busy the app keeps the Mac awake. If the page loses its connection to R (for example after sleep) it reconnects by itself. **View > Restart R** restarts the R process.
- The log is at `~/Library/Logs/AstroSharp/AstroSharp.log` (**Help > Show Log File**).
- To uninstall, delete the app, `/Users/Shared/AstroSharp`, `~/Library/Logs/AstroSharp` and `~/Library/Application Support/AstroSharp`.

`AstroSharp (browser mode).command` is a fallback that shows the same app in the default web browser. It works once the app has been opened at least once. If double-clicking it does nothing, make it executable first: `chmod +x "AstroSharp (browser mode).command"`.

## What is in this folder

| Path | What it is |
| --- | --- |
| `app/main.js`, `preload.js`, `splash.html` | The Electron shell. It replaces `resources/app/main.js` (Electron 5, fixed port 9191) for the Mac. |
| `app/r/launch.R` | Starts the Shiny app inside R and applies the Mac-specific fixes described below. |
| `app/r/pkgs/neuralnet_1.44.6.tar.gz` | Source of the `neuralnet` version the models need (see below). |
| `AstroSharp (browser mode).command` | Browser-mode fallback launcher. |
| `build/build.sh` | Builds the app. Runs on Linux; no Mac needed. |
| `build/conda_env.py`, `cross_compile.sh`, `make_payload.py`, `package.js`, `codesign-shim.sh` | The steps `build.sh` runs. |
| `build/waveslim-placeholder/` | Empty stand-in for the `waveslim` package (see below). |
| `build/locks/osx-arm64.json` | The exact conda packages in the runtime of the first build. |

## How the Mac build differs from the Windows build

- **Shell.** Electron 45. It picks a free port, shows start-up progress, opens external links in the browser, and stops R (and its worker processes) when the app quits.
- **R.** R 4.5.3 from conda-forge with current package versions, where the Windows build has R 4.2.2. A conda environment is built for one fixed location, so the app ships it as an archive and unpacks it to `/Users/Shared/AstroSharp/runtime` on first launch. The Shiny app files are copied next to it and R runs them from there.
- **neuralnet.** The Windows bundle contains `neuralnet` 1.44.6 from [bips-hb/neuralnet](https://github.com/bips-hb/neuralnet) (commit `0981535`), not the CRAN release. The models rely on it: they have ReLU hidden layers and a logistic output layer, and CRAN's 1.44.2 applies ReLU to the output too, which leaves most of a processed image black. The Mac build installs the same 1.44.6 source.
- **tiff and imager.** conda-forge has no osx-arm64 build of these two R packages, so their native code is cross-compiled by `build/cross_compile.sh`. `imager` is built without its X11 display window, so XQuartz is not needed, and without OpenMP. AstroSharp uses neither.
- **waveslim.** `app.R` attaches `waveslim` but calls nothing from it or from its dependency `multitaper` (checked against every symbol used in `app.R` and the files it sources). `multitaper` contains Fortran, which this build cannot cross-compile, so an empty placeholder package named `waveslim` satisfies the `library()` call.
- **Multicore.** `launch.R` makes the `snow` workers connect to `localhost` instead of the machine's host name. `snow` also refuses to start workers from a library path that contains a space, which is one reason the runtime does not live under `~/Library/Application Support`.
- **Other fixes in `launch.R`.** `app.R` calls `par()` outside a plot, which makes R write an `Rplots.pdf` into the working directory; a null PDF device is used instead. `app.R` stops the server when the browser session ends; in the windowed app that call is shadowed, so reloading the window does not kill R, and R exits by itself if the window process disappears.
- **Left out.** Files in `resources/app` that `app.R` never loads (the other `app*.R` variants, `Unstretched`, the `PSF` subfolders) are not copied into the Mac app.

If the app is built without a bundled runtime, `main.js` falls back to an R installed on the Mac and `launch.R` installs the CRAN packages into a private library on first launch. That route needs XQuartz (CRAN's `imager` links against X11).

## Building

On Linux x86_64:

```bash
# once
pip install -r macos/build/requirements.txt          # py-rattler, ziglang
# rcodesign from https://github.com/indygreg/apple-platform-rs/releases on the PATH
sudo install -m 755 macos/build/codesign-shim.sh /usr/bin/codesign

# build
bash macos/build/build.sh
```

Node.js and git are also needed. The build downloads about 600 MB of conda packages plus Electron, and needs about 3 GB of scratch space (`macos/build/work`). With the downloads cached it takes a few minutes. The app ends up in `macos/build/work/out/AstroSharp-darwin-arm64/AstroSharp.app`; move it to a Mac as a `.tar.gz` or `.zip` that preserves symlinks and permissions.

What `build.sh` does:

1. Installs the osx-arm64 conda environment with `py-rattler`, with `/Users/Shared/AstroSharp/runtime` baked in as its location and without the compiler toolchain that `r-base` depends on. Binaries whose embedded prefix is rewritten are re-signed through the `codesign` stand-in.
2. Installs the same R for Linux, used only to install R-level package files.
3. Cross-compiles `tiff.so` and `imager.so` for macOS arm64 with zig.
4. Adds `neuralnet` 1.44.6, the `waveslim` placeholder, and `tiff`, `imager` and `readbitmap` (R-level files from the Linux packages of the same versions, native libraries swapped) to the Mac R library. conda-forge's R does not check which platform a package was built on, which is what makes this work.
5. Packs the runtime as `runtime.tar.gz` with a `runtime.json` describing it.
6. Stages `app/` plus the Shiny files from `resources/app`, wraps them with `@electron/packager`, and signs the bundle ad hoc with `rcodesign`.

The package versions are not pinned beyond `r-base=4.5`, so a rebuild picks up whatever conda-forge has at the time; `build/locks/osx-arm64.json` records the first build.

## How it was checked

- **Against the Windows build.** `R-Portable-Win` from this repository was run under Wine and compared with the conda R 4.5.3 package set (built for Linux) on the two sample images `T1.tif` and `CT1.tif`, for every model in preview and full-image mode, single core and multicore: 52 results, all equal to within floating-point rounding (largest difference about 3e-15).
- **The launcher.** Start-up, unpacking the bundled R, processing, download, reload, reconnect and quit were tested end to end on Linux with the Linux build of Electron.
- **On a Mac.** The app was opened on one Apple silicon Mac: the bundled R unpacked and started, a TIFF loaded, and a preview processed with PSF Model (Pre-Beta) on a single core and with Dual PSF on Multicore.

Not checked on a Mac: saving the processed file, the other models, full-image runs, the browser-mode launcher, and Intel Macs (not supported by this build). The cross-compiled `tiff` and `imager` libraries were not compared number-for-number with Windows; they are compiled from the same source.

## Licenses

The launcher files in this folder are offered under the same license as the rest of the repository. `neuralnet` is GPL (>= 2); the tarball is its complete, unmodified source. The bundled runtime consists of conda-forge packages, each under its own license (R itself is GPL); the built runtime keeps their records in `conda-meta`.
