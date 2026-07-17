#!/usr/bin/env node
const action = process.argv[2];
process.stdout.write(JSON.stringify({ action, env: process.env.HERDR_ENV, plugin: process.env.HERDR_PLUGIN_ID }) + "\n");
