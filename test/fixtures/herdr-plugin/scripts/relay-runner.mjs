#!/usr/bin/env node
process.stdout.write(JSON.stringify({ entrypoint: process.env.HERDR_PLUGIN_ENTRYPOINT_ID, run: process.env.PI_RUN_ID }) + "\n");
