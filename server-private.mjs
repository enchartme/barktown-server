#!/usr/bin/env node
/** Tailnet-only Barktown mutation and operator API. */

process.env.BARKTOWN_API_MODE = "private";
await import("./server.mjs");
