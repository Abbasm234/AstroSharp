#!/bin/bash
# Stand-in for Apple's codesign when building on Linux.
#
# The conda installer rewrites the install prefix inside some Mach-O binaries
# and then calls `/usr/bin/codesign -s - -f <file>` to give them a fresh ad-hoc
# signature (Apple silicon refuses to run a binary whose signature no longer
# matches). On Linux there is no codesign, so install this script in its place:
#
#   sudo install -m 755 codesign-shim.sh /usr/bin/codesign
#
# It does the same job with rcodesign (https://github.com/indygreg/apple-platform-rs),
# found through $RCODESIGN or on the PATH.
file="${*: -1}"
exec "${RCODESIGN:-rcodesign}" sign "$file" >/dev/null 2>&1
