#!/usr/bin/env -S node
import { scanMain } from "./scan.ts";

scanMain().catch((error) => {
  console.error(`\nscan: ${(error as Error).stack ?? String(error)}`);
  process.exit(2);
});
