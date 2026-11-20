#!/bin/bash
# AstroSharp in your web browser.
#
# A fallback for AstroSharp.app: it runs the same R code but shows the app in
# your default browser instead of its own window. Close the browser tab, or
# this Terminal window, to quit.
#
# It uses the copy of R that AstroSharp.app unpacks the first time it is opened
# (in /Users/Shared/AstroSharp). If that is not there, it falls back to an R
# installed on this Mac together with the files inside AstroSharp.app, which
# must then be next to this file or in Applications.

SHARED="/Users/Shared/AstroSharp"
[ -n "$LANG$LC_ALL" ] || export LANG=en_US.UTF-8
export ASTROSHARP_MODE=browser

if [ -x "$SHARED/runtime/bin/Rscript" ] && [ -f "$SHARED/app/r/launch.R" ]; then
  RSCRIPT="$SHARED/runtime/bin/Rscript"
  RES="$SHARED/app"
  export ASTROSHARP_BUNDLED=1
  export R_LIBS_USER="$SHARED/runtime/no-user-library"
  export R_PROFILE_USER="$RES/r/empty" R_ENVIRON_USER="$RES/r/empty"
  unset R_HOME RHOME R_LIBS R_LIBS_SITE R_PROFILE R_ENVIRON R_DEFAULT_PACKAGES
else
  HERE="$(cd "$(dirname "$0")" && pwd)"
  RES=""
  for candidate in "$HERE/AstroSharp.app" "/Applications/AstroSharp.app" "$HOME/Applications/AstroSharp.app"; do
    if [ -f "$candidate/Contents/Resources/app/r/launch.R" ]; then
      RES="$candidate/Contents/Resources/app"
      break
    fi
  done
  RSCRIPT="${ASTROSHARP_RSCRIPT:-}"
  if [ -z "$RSCRIPT" ]; then
    for candidate in /Library/Frameworks/R.framework/Resources/bin/Rscript /opt/homebrew/bin/Rscript \
                     /usr/local/bin/Rscript /opt/local/bin/Rscript "$HOME/.homebrew/bin/Rscript" \
                     "$(command -v Rscript 2>/dev/null)"; do
      if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        RSCRIPT="$candidate"
        break
      fi
    done
  fi
  if [ -z "$RES" ] || [ -z "$RSCRIPT" ]; then
    echo "AstroSharp has not been set up on this Mac yet."
    echo "Open AstroSharp.app once (it unpacks its own copy of R), then run this again."
    read -r -p "Press Return to close." _
    exit 1
  fi
  # A package folder without spaces in its path, which R's multicore code requires.
  export ASTROSHARP_LIB="${ASTROSHARP_LIB:-$HOME/Library/AstroSharp/R-library}"
fi

export ASTROSHARP_APPDIR="$RES/shiny"
echo "Starting AstroSharp with $RSCRIPT"
echo "The app opens in your browser. Close the browser tab (or this window) to quit."
echo
cd "$HOME" || exit 1
"$RSCRIPT" --vanilla "$RES/r/launch.R"
status=$?
if [ $status -ne 0 ]; then
  echo
  read -r -p "AstroSharp stopped with an error (see above). Press Return to close." _
fi
exit $status
