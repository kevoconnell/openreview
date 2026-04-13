#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { generateReview } from "../index.js";
import { DEFAULT_REVIEW_CONFIG } from "../config/review-config.js";
import { ensureViewerControlServer } from "../viewer/control-server.js";
import { syncViewerPayloads } from "../viewer/payload.js";
import { syncCheckedInViewerAssets } from "../viewer/sync-viewer-assets.js";

type TReviewIntent = "full" | "incremental";

type TNativeCommand =
  | "generate"
  | "open"
  | "refresh"
  | "show-overview"
  | "show-doc"
  | "status"
  | "service"
  | "stop";

const SUPPORTED_COMMANDS = new Set<TNativeCommand>([
  "open",
  "refresh",
  "show-overview",
  "show-doc",
  "status",
  "service",
  "stop",
]);

function resolveInvocationDir(): string {
  const initCwd = process.env.INIT_CWD?.trim();
  return initCwd ? path.resolve(initCwd) : process.cwd();
}

function getCommand(argv: string[]): TNativeCommand {
  const command = argv.find((argument) => !argument.startsWith("-"));
  if (
    typeof command === "string" &&
    SUPPORTED_COMMANDS.has(command as TNativeCommand)
  ) {
    return command as TNativeCommand;
  }

  if (command === "generate") {
    return "generate";
  }

  return "open";
}

function parseArgs(argv: string[]): {
  repoPath: string;
  mode: TReviewIntent;
  docFileName: string | null;
} {
  const invocationDir = resolveInvocationDir();
  let repoPath = invocationDir;
  let mode: TReviewIntent = "full";
  let docFileName: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--local") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --local");
      }
      repoPath = path.resolve(invocationDir, value);
      index += 1;
      continue;
    }

    if (argument === "--incremental") {
      mode = "incremental";
      continue;
    }

    if (!argument.startsWith("-") && docFileName === null) {
      docFileName = argument;
    }
  }

  return { repoPath, mode, docFileName };
}

function getCommandArgs(argv: string[], command: TNativeCommand): string[] {
  if (command === "generate") {
    return argv;
  }

  const nextArgs = [...argv];
  const commandIndex = nextArgs.findIndex((argument) => argument === command);
  if (commandIndex >= 0) {
    nextArgs.splice(commandIndex, 1);
  }
  return nextArgs;
}

function getOutputPaths(repoPath: string): {
  outputDir: string;
  overviewPath: string;
  fileInsightsPath: string;
} {
  const outputDir = path.join(repoPath, DEFAULT_REVIEW_CONFIG.outputDirName);
  return {
    outputDir,
    overviewPath: path.join(outputDir, "overview.md"),
    fileInsightsPath: path.join(outputDir, "file-insights.json"),
  };
}

async function ensurePathExists(
  targetPath: string,
  description: string,
): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`${description} not found at ${targetPath}`);
  }
}

async function findLatestViewerIndexPath(
  repoPath: string,
): Promise<string | null> {
  const viewerDir = path.join(
    repoPath,
    DEFAULT_REVIEW_CONFIG.outputDirName,
    "runtime",
    "viewer",
  );

  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = (await fs.readdir(viewerDir, { withFileTypes: true })).map(
      (entry) => ({
        name: String(entry.name),
        isDirectory: () => entry.isDirectory(),
      }),
    );
  } catch {
    return null;
  }

  const viewerEntries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const indexPath = path.join(viewerDir, entry.name, "index.html");
        try {
          const stat = await fs.stat(indexPath);
          return { indexPath, modifiedAt: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const latestEntry = viewerEntries
    .filter(
      (
        entry,
      ): entry is {
        indexPath: string;
        modifiedAt: number;
      } => entry !== null,
    )
    .sort(
      (leftEntry, rightEntry) => rightEntry.modifiedAt - leftEntry.modifiedAt,
    )[0];

  return latestEntry?.indexPath ?? null;
}

async function getOverviewOpenPath(repoPath: string): Promise<string> {
  await syncCheckedInViewerAssets({ repoPath });
  const viewerIndexPath = await findLatestViewerIndexPath(repoPath);
  if (!viewerIndexPath) {
    return getOutputPaths(repoPath).overviewPath;
  }

  const controlPort = await ensureViewerControlServer({ repoPath });
  await syncViewerPayloads({ repoPath, controlPort });
  return viewerIndexPath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function openPathInDefaultApp(targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [targetPath], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Failed to open ${targetPath}`));
    });

    child.on("error", reject);
  });
}

async function tryOpenPathInCmux(targetPath: string): Promise<boolean> {
  const hasCmuxContext = Boolean(
    process.env.CMUX_WORKSPACE_ID?.trim() ||
    process.env.CMUX_SURFACE_ID?.trim(),
  );
  if (!hasCmuxContext) {
    return false;
  }

  const targetUrl = pathToFileURL(targetPath).toString();

  return await new Promise<boolean>((resolve) => {
    const child = spawn("cmux", ["browser", "open", targetUrl], {
      stdio: "ignore",
      env: process.env,
    });

    child.on("exit", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

async function openPath(targetPath: string): Promise<void> {
  if (await tryOpenPathInCmux(targetPath)) {
    return;
  }

  await openPathInDefaultApp(targetPath);
}

async function runGenerate({
  repoPath,
  mode,
  quiet = false,
}: {
  repoPath: string;
  mode: TReviewIntent;
  quiet?: boolean;
}) {
  const result = await generateReview({
    repoPath,
    mode,
  });

  if (!quiet) {
    process.stdout.write(
      `${JSON.stringify(
        {
          outputDir: result.outputDir,
          overviewPath: result.overviewPath,
          fileInsightsPath: result.fileInsightsPath,
        },
        null,
        2,
      )}\n`,
    );
  }

  const controlPort = await ensureViewerControlServer({ repoPath });
  await syncViewerPayloads({ repoPath, controlPort });

  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = getCommand(argv);
  const commandArgs = getCommandArgs(argv, command);
  const { repoPath, mode, docFileName } = parseArgs(commandArgs);

  switch (command) {
    case "generate":
    case "refresh": {
      await runGenerate({ repoPath, mode });
      return;
    }
    case "open": {
      let targetPath = await getOverviewOpenPath(repoPath);
      if (!(await pathExists(targetPath))) {
        const result = await runGenerate({ repoPath, mode, quiet: true });
        targetPath = (await getOverviewOpenPath(repoPath)) || result.overviewPath;
      }
      await ensurePathExists(targetPath, "Overview file");
      await openPath(targetPath);
      return;
    }
    case "show-overview": {
      const targetPath = await getOverviewOpenPath(repoPath);
      await ensurePathExists(targetPath, "Overview file");
      await openPath(targetPath);
      return;
    }
    case "show-doc": {
      if (!docFileName) {
        throw new Error("Missing document name for show-doc");
      }
      const { outputDir } = getOutputPaths(repoPath);
      const targetPath = path.resolve(outputDir, docFileName);
      if (
        !targetPath.startsWith(`${outputDir}${path.sep}`) &&
        targetPath !== path.resolve(outputDir)
      ) {
        throw new Error(
          "show-doc only supports files inside the review output directory",
        );
      }
      await ensurePathExists(targetPath, "Document");
      await openPath(targetPath);
      return;
    }
    case "status": {
      const { outputDir, overviewPath, fileInsightsPath } =
        getOutputPaths(repoPath);
      const viewerIndexPath = await findLatestViewerIndexPath(repoPath);
      const [
        outputDirExists,
        overviewExists,
        fileInsightsExists,
        viewerIndexExists,
      ] = await Promise.all([
        fs
          .access(outputDir)
          .then(() => true)
          .catch(() => false),
        fs
          .access(overviewPath)
          .then(() => true)
          .catch(() => false),
        fs
          .access(fileInsightsPath)
          .then(() => true)
          .catch(() => false),
        viewerIndexPath
          ? fs
              .access(viewerIndexPath)
              .then(() => true)
              .catch(() => false)
          : Promise.resolve(false),
      ]);
      process.stdout.write(
        `${JSON.stringify(
          {
            repoPath,
            outputDir,
            outputDirExists,
            overviewPath,
            overviewExists,
            viewerIndexPath,
            viewerIndexExists,
            fileInsightsPath,
            fileInsightsExists,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    case "service":
    case "stop": {
      throw new Error(
        `The native OpenReview CLI does not support the \`${command}\` command.`,
      );
    }
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
