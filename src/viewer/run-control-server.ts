#!/usr/bin/env node

import process from "node:process";
import { runViewerControlServer } from "./control-server.js";

function readFlag(flagName: string): string | null {
  const index = process.argv.indexOf(flagName);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const repoPath = readFlag("--repo-path");
  const outputDirName = readFlag("--output-dir-name") ?? ".openreview";
  const port = Number.parseInt(readFlag("--port") ?? "", 10);

  if (!repoPath) {
    throw new Error("Missing --repo-path");
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Missing or invalid --port");
  }

  await runViewerControlServer({ repoPath, outputDirName, port });
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
