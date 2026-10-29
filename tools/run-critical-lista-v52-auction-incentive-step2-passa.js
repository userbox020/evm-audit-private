#!/usr/bin/env node
"use strict";
const reason = "REJECTED_GENERIC_PACKAGE_DISABLED_USE_MBTC_SCOPED_PACKAGE";
process.stderr.write(`${JSON.stringify({ status: "STOPPED", reason })}\n`);
process.exitCode = 1;
