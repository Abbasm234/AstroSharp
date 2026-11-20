# AstroSharp launcher for macOS (also works on Linux).
#
# The Windows build ships a private copy of R ("R-Portable-Win") with every
# package pre-installed. The macOS app does the same (ASTROSHARP_BUNDLED=1): its
# own R with all packages in place, in which case this script only applies a few
# platform fixes and starts the unmodified Shiny app.
#
# Without a bundled R (the browser-mode launcher on a Mac that has R, or other
# platforms) it uses the R that is installed on the machine and makes sure the
# packages app.R needs are present, installing them into a private library on
# first launch.
#
# Configuration comes from environment variables so that the same script serves
# the windowed app (Electron) and the browser-mode .command launcher:
#   ASTROSHARP_APPDIR      directory that contains app.R            (required)
#   ASTROSHARP_BUNDLED     set when running the app's own copy of R
#   ASTROSHARP_LIB         where the private package library lives
#                          (required unless ASTROSHARP_BUNDLED is set)
#   ASTROSHARP_PORT        port to listen on (default: a free one)
#   ASTROSHARP_MODE        "window" (Electron) or "browser" (default)
#   ASTROSHARP_PARENT_PID  pid of the Electron process, window mode only
#   ASTROSHARP_REPO        CRAN mirror (default https://cloud.r-project.org)

MODE     <- Sys.getenv("ASTROSHARP_MODE", "browser")
APPDIR   <- Sys.getenv("ASTROSHARP_APPDIR")
LIBROOT  <- Sys.getenv("ASTROSHARP_LIB")
REPO     <- Sys.getenv("ASTROSHARP_REPO", "https://cloud.r-project.org")
WINDOWED <- identical(MODE, "window")
BUNDLED  <- nzchar(Sys.getenv("ASTROSHARP_BUNDLED"))
IS_MAC   <- identical(unname(Sys.info()[["sysname"]]), "Darwin")
TAG      <- "@@ASTROSHARP@@"

# neuralnet is the one package the Windows build does NOT take from CRAN: it
# bundles version 1.44.6 from github.com/bips-hb/neuralnet (commit 0981535).
# The trained networks in the .RDS files were made with that version (ReLU
# hidden layers, logistic output layer). CRAN's neuralnet 1.44.2 does not know
# about a separate output activation and applies ReLU to the output as well,
# which silently turns most of a processed image black. The same source is
# shipped next to this script and installed into the private library.
# (The app folder holds shiny/ and r/ side by side; r/pkgs has the tarball.)
NEURALNET_VERSION <- "1.44.6"
NEURALNET_TARBALL <- file.path(dirname(normalizePath(APPDIR, mustWork = FALSE)), "r", "pkgs",
                               paste0("neuralnet_", NEURALNET_VERSION, ".tar.gz"))

# Packages attached by app.R and the files it sources ('parallel' ships with R).
REQUIRED <- c("shiny", "shinycssloaders", "neuralnet", "dplyr", "ggthemes",
              "tiff", "htmltools", "reshape2", "waveslim", "imager", "bslib",
              "foreach", "doParallel", "doSNOW", "shinyWidgets")
# Not needed to run, but the Windows bundle has it and Shiny draws its plots
# with it when present, which avoids any dependency on quartz/X11/cairo devices.
OPTIONAL <- c("ragg")

# ---- messages to the launcher ------------------------------------------------

json_str <- function(x) {
  x <- paste(as.character(x), collapse = "\n")
  x <- gsub("\\", "\\\\", x, fixed = TRUE)
  x <- gsub("\"", "\\\"", x, fixed = TRUE)
  x <- gsub("\r", "", x, fixed = TRUE)
  x <- gsub("\t", " ", x, fixed = TRUE)
  x <- gsub("\n", "\\n", x, fixed = TRUE)
  paste0("\"", x, "\"")
}

# In window mode every event is one tagged JSON line on stdout, which the
# Electron main process parses. In browser mode the same events are printed as
# plain text for whoever is looking at the Terminal window.
emit <- function(type, ...) {
  fields <- list(...)
  if (WINDOWED) {
    body <- ""
    if (length(fields)) {
      vals <- vapply(fields, function(v) {
        if (is.numeric(v) && length(v) == 1) format(v, scientific = FALSE) else json_str(v)
      }, character(1))
      body <- paste0(",", paste0("\"", names(fields), "\":", vals, collapse = ","))
    }
    cat(TAG, " {\"type\":", json_str(type), body, "}\n", sep = "")
  } else if (!is.null(fields$message)) {
    cat(if (identical(type, "error")) "\nERROR: " else "==> ", fields$message, "\n", sep = "")
  }
  flush(stdout())
}

fail <- function(code, message) {
  emit("error", code = code, message = message)
  quit(save = "no", status = 3)
}

# ---- sanity checks -----------------------------------------------------------

if (!nzchar(APPDIR) || !file.exists(file.path(APPDIR, "app.R")))
  fail("config", paste0("Could not find app.R in '", APPDIR, "'."))
if (!BUNDLED && !nzchar(LIBROOT))
  fail("config", "ASTROSHARP_LIB is not set.")
if (getRversion() < "4.1.0")
  fail("rversion", paste0("AstroSharp needs R 4.1 or newer, but this is R ",
                          as.character(getRversion()), "."))

# ---- private package library -------------------------------------------------

if (BUNDLED) {
  # The bundled R is self-contained: use its own library and nothing else.
  .libPaths(character())
  LIB <- .Library
} else {
  # One library per R minor version and CPU architecture, so upgrading R (or
  # switching between an Intel and an Apple Silicon build) starts from a clean one.
  r_minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1]][1]
  LIB <- file.path(LIBROOT, paste0(R.version$major, ".", r_minor, "-", R.version$arch))
  dir.create(LIB, recursive = TRUE, showWarnings = FALSE)
  if (!dir.exists(LIB) || file.access(LIB, 2) != 0)
    fail("config", paste0("Cannot write to the package library folder '", LIB, "'."))
  LIB <- normalizePath(LIB)
  if (grepl("[[:space:]]", LIB))
    message("Note: the package library path contains a space (", LIB, "). The ",
            "Multicore option will not work from such a path; set ASTROSHARP_LIB ",
            "to a folder without spaces.")
  .libPaths(c(LIB, .libPaths()))
  # The multicore models start extra R worker processes; R_LIBS makes those
  # workers see the same private library.
  Sys.setenv(R_LIBS = paste(unique(c(LIB, Filter(nzchar, Sys.getenv("R_LIBS")))),
                            collapse = .Platform$path.sep))
}

options(repos = c(CRAN = REPO), timeout = max(900, getOption("timeout")),
        install.packages.check.source = "no",
        install.packages.compile.from.source = "never")

# Load every package in a throwaway R process so a broken package cannot take
# this process down with it. Returns a named character vector of error messages
# (empty when everything loads).
load_errors <- function(pkgs) {
  code <- paste0(
    "for (p in commandArgs(TRUE)) {",
    " e <- tryCatch({ suppressPackageStartupMessages(loadNamespace(p)); '' },",
    "   error = function(e) conditionMessage(e));",
    " cat('<<', p, '>>', gsub('[\\r\\n]+', ' ', e), '\\n', sep = '') }")
  out <- suppressWarnings(system2(file.path(R.home("bin"), "Rscript"),
                                  c("--vanilla", "-e", shQuote(code), pkgs),
                                  stdout = TRUE, stderr = FALSE))
  res <- stats::setNames(rep("could not be checked", length(pkgs)), pkgs)
  for (line in grep("^<<.+>>", out, value = TRUE)) {
    p <- sub("^<<(.+?)>>.*$", "\\1", line, perl = TRUE)
    if (p %in% pkgs) res[[p]] <- sub("^<<.+?>>", "", line, perl = TRUE)
  }
  res[nzchar(res)]
}

is_x11_problem <- function(msgs) {
  any(grepl("X11|libX11|xquartz", msgs, ignore.case = TRUE)) ||
    (IS_MAC && "imager" %in% names(msgs) && !file.exists("/opt/X11/lib/libX11.6.dylib"))
}

XQUARTZ_MSG <- paste0(
  "The R package 'imager' (used for star detection and for drawing the previews) ",
  "needs the X11 libraries, which macOS does not include. Install XQuartz from ",
  "https://www.xquartz.org and then open AstroSharp again.")

installed_in <- function(lib) rownames(utils::installed.packages(lib.loc = lib, noCache = TRUE))

install_everything <- function() {
  binary <- !identical(.Platform$pkgType, "source")
  type   <- if (binary) "binary" else "source"
  emit("status", message = "Checking which R packages are needed\u2026")
  ap <- tryCatch(suppressWarnings(utils::available.packages(repos = REPO, type = type)),
                 error = function(e) NULL)
  if (is.null(ap) || !nrow(ap))
    fail("network", paste0(
      "AstroSharp needs to download its R packages the first time it runs, but ",
      "the package server (", REPO, ") could not be reached. Check the internet ",
      "connection and try again."))

  base_pkgs <- rownames(utils::installed.packages(lib.loc = .Library, priority = "base"))
  closure <- function(pkgs) {
    deps <- tools::package_dependencies(pkgs, db = ap, recursive = TRUE,
                                        which = c("Depends", "Imports", "LinkingTo"))
    setdiff(unique(c(pkgs, unlist(deps, use.names = FALSE))), base_pkgs)
  }
  # neuralnet's dependencies come from CRAN, neuralnet itself does not (see above).
  need     <- setdiff(closure(REQUIRED), "neuralnet")
  optional <- setdiff(closure(OPTIONAL), need)
  todo     <- setdiff(c(need, optional), installed_in(LIB))
  if (!length(todo)) return(invisible())

  emit("install", total = length(todo), source = !binary,
       message = sprintf("Installing %d R packages (first launch only)\u2026", length(todo)))
  run <- function(pkgs, type) {
    tryCatch(utils::install.packages(pkgs, lib = LIB, repos = REPO, type = type,
                                     dependencies = FALSE,
                                     Ncpus = max(1L, min(4L, parallel::detectCores() - 1L))),
             error = function(e) message("install.packages failed: ", conditionMessage(e)))
  }
  run(intersect(todo, rownames(ap)), type)
  # Anything without a ready-made binary gets one attempt from source.
  left <- setdiff(todo, installed_in(LIB))
  if (binary && length(left)) {
    options(install.packages.compile.from.source = "always")
    run(left, "source")
  }
  missing <- setdiff(need, installed_in(LIB))
  if (length(missing))
    fail("install", paste0(
      "These R packages could not be installed: ", paste(missing, collapse = ", "),
      ". The log has the details.",
      if (!binary) paste0(" This copy of R builds every package from source; the ",
                          "R installer from https://cloud.r-project.org uses ",
                          "ready-made packages and is the easier route.") else ""))
}

neuralnet_ok <- function() {
  v <- tryCatch(as.character(utils::packageVersion("neuralnet", lib.loc = LIB)),
                error = function(e) "")
  identical(v, NEURALNET_VERSION)
}

install_neuralnet <- function() {
  emit("status", message = "Installing the neural network package\u2026")
  if (!file.exists(NEURALNET_TARBALL))
    fail("config", paste0("The bundled neuralnet package is missing (", NEURALNET_TARBALL, ")."))
  # Its two dependencies: MASS ships with R, Deriv comes from CRAN.
  deps <- load_errors(c("MASS", "Deriv"))
  if (length(deps)) {
    type <- if (identical(.Platform$pkgType, "source")) "source" else "binary"
    tryCatch(utils::install.packages(names(deps), lib = LIB, repos = REPO, type = type),
             error = function(e) message("install.packages failed: ", conditionMessage(e)))
  }
  # Plain R code, so installing from source needs no compiler.
  tryCatch(utils::install.packages(NEURALNET_TARBALL, lib = LIB, repos = NULL, type = "source"),
           error = function(e) message("install.packages failed: ", conditionMessage(e)))
  if (!neuralnet_ok())
    fail("install", paste0("The bundled neuralnet ", NEURALNET_VERSION,
                           " package could not be installed. The log has the details."))
}

if (BUNDLED) {
  # Everything is already installed. The first time this copy of R runs, make
  # sure every package really loads on this machine, and remember that it did.
  checked <- file.path(R.home(), ".astrosharp-checked")
  if (!file.exists(checked)) {
    emit("status", message = "Checking the bundled R packages\u2026")
    errs <- load_errors(REQUIRED)
    if (!neuralnet_ok())
      errs <- c(errs, neuralnet = paste("expected version", NEURALNET_VERSION))
    if (length(errs))
      fail("load", paste0("AstroSharp's own copy of R is not working; these packages will not load:\n",
                          paste0("  ", names(errs), ": ", errs, collapse = "\n")))
    try(writeLines(R.version.string, checked), silent = TRUE)
  }
} else {
  emit("status", message = "Checking R packages\u2026")
  others  <- setdiff(REQUIRED, "neuralnet")
  errs    <- load_errors(others)
  changed <- FALSE
  if (length(errs)) {
    if (IS_MAC && all(names(errs) == "imager") && is_x11_problem(errs))
      fail("xquartz", XQUARTZ_MSG)
    # Something is missing or broken: build a complete, self-consistent set in the
    # private library (which is first on the search path).
    install_everything()
    changed <- TRUE
  }
  if (!neuralnet_ok()) {
    install_neuralnet()
    changed <- TRUE
  }
  if (changed) {
    emit("status", message = "Checking R packages\u2026")
    errs <- load_errors(REQUIRED)
    if (length(errs)) {
      if (is_x11_problem(errs)) fail("xquartz", XQUARTZ_MSG)
      fail("load", paste0("Some R packages are installed but will not load:\n",
                          paste0("  ", names(errs), ": ", errs, collapse = "\n")))
    }
  }
}

# ---- platform fixes ----------------------------------------------------------

# 1) The multicore models call snow::makeCluster(), whose workers connect back
#    to the master by the machine's host name. That depends on the Mac being
#    able to resolve its own name, which is not a given (VPNs, odd DNS setups,
#    stale ".local" names), and when it fails "Multicore" just waits forever.
#    Everything runs on this machine, so use the loopback name instead.
snow::setDefaultClusterOptions(master = "localhost")

# 2) app.R calls par() outside of a plot, which makes R open its default
#    graphics device. From a script that is a file called Rplots.pdf in the
#    working directory, i.e. inside the application bundle. Use a PDF device
#    that writes nowhere instead.
options(device = function(...) grDevices::pdf(file = NULL))

if (WINDOWED) {
  # 3) app.R shuts the whole server down when the browser session ends. In the
  #    windowed app the Electron process owns R's lifetime, and stopping here
  #    would turn "reload the window" or a dropped connection after sleep into
  #    a dead app. Code sourced by Shiny looks up names in the global
  #    environment before the shiny package, so this shadows stopApp() for
  #    app.R only; app.R itself stays untouched.
  assign("stopApp", function(...) invisible(NULL), envir = globalenv())

  # 4) ...and in exchange, exit if the window process disappears without
  #    stopping us (force quit, crash).
  parent <- suppressWarnings(as.integer(Sys.getenv("ASTROSHARP_PARENT_PID", "")))
  if (!is.na(parent) && parent > 1L) {
    watchdog <- function() {
      alive <- tryCatch(isTRUE(tools::pskill(parent, 0L)), error = function(e) TRUE)
      if (alive) later::later(watchdog, 5) else {
        message("AstroSharp window process is gone; stopping R.")
        quit(save = "no", status = 0)
      }
    }
    later::later(watchdog, 5)
  }
}

# ---- run ---------------------------------------------------------------------

port <- suppressWarnings(as.integer(Sys.getenv("ASTROSHARP_PORT", "")))
if (is.na(port)) port <- httpuv::randomPort()

emit("status", message = "Starting AstroSharp\u2026")
emit("starting", port = port)
shiny::runApp(APPDIR, port = port, host = "127.0.0.1",
              launch.browser = !WINDOWED, quiet = FALSE)
