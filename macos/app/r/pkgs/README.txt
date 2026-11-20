neuralnet_1.44.6.tar.gz

Source of the R package "neuralnet", version 1.44.6, exactly as found at
https://github.com/bips-hb/neuralnet (commit 09815356b9aea12f184ff91f0389e94321a99f3e).
This is the version the Windows build of AstroSharp bundles; the networks in the
.RDS files need it (CRAN's 1.44.2 gives wrong results with them). build.sh
installs it into the R runtime that ships with the app; when the app runs on an
R installed on the Mac instead, launch.R installs it on first launch.

neuralnet is by Stefan Fritsch, Frauke Guenther and Marvin N. Wright, licensed
GPL (>= 2). The tarball is the complete, unmodified source.
