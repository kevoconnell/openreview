import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveReviewConfig } from "../../config/review-config.js";
import { getReviewOutputDirName, type TReviewScope } from "../../config/review-scope.js";
import { runOpenCodePrompt } from "../../opencode/review-client.js";
import { ensureRepoOpenCodeServer, resolveRepoRoot } from "../../opencode/server.js";
import { generateReview } from "../../pipeline/generate-review.js";
import {
  normalizeReviewCompare,
  type TReviewCompare,
} from "../../schemas/review-range.js";
import { syncCheckedInViewerAssets } from "../build/sync-assets.js";
import { syncViewerPayloads } from "../data/sync-payloads.js";

type TViewerControlServerState = {
  codeVersion?: string;
  serverVersion?: number;
  pid: number | null;
  port: number;
  repoPath: string;
  outputDirName: string;
  startedAt: string;
};

const VIEWER_CONTROL_SERVER_VERSION = 2;

function getRuntimeDir({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(repoPath, outputDirName, "runtime");
}

function getStatePath({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(
    getRuntimeDir({ repoPath, outputDirName }),
    "viewer-control-server.json",
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveViewerControlCodeVersion({
  moduleDir,
}: {
  moduleDir: string;
}): Promise<string> {
  const repoRoot = path.resolve(moduleDir, "../../..");
  const candidateGroups = [
    [
      "src/viewer/server/control-server.ts",
      "dist/viewer/server/control-server.js",
    ],
    [
      "src/viewer/server/run-control-server.ts",
      "dist/viewer/server/run-control-server.js",
    ],
    ["src/pipeline/generate-review.ts", "dist/pipeline/generate-review.js"],
    [
      "src/collectors/repo-snapshot.ts",
      "dist/collectors/repo-snapshot.js",
    ],
    [
      "src/pipeline/build-review-prompt.ts",
      "dist/pipeline/build-review-prompt.js",
    ],
    [
      "src/pipeline/build-repo-review-prompt.ts",
      "dist/pipeline/build-repo-review-prompt.js",
    ],
    ["src/config/review-scope.ts", "dist/config/review-scope.js"],
  ];

  const signatures: string[] = [];
  for (const candidates of candidateGroups) {
    for (const relativePath of candidates) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!(await pathExists(absolutePath))) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      signatures.push(
        `${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`,
      );
      break;
    }
  }

  return createHash("sha1")
    .update(`${VIEWER_CONTROL_SERVER_VERSION}\n${signatures.join("\n")}`)
    .digest("hex");
}

async function readServerState({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): Promise<TViewerControlServerState | null> {
  const statePath = getStatePath({ repoPath, outputDirName });
  if (!(await pathExists(statePath))) {
    return null;
  }

  try {
    const content = await fs.readFile(statePath, "utf8");
    return JSON.parse(content) as TViewerControlServerState;
  } catch {
    return null;
  }
}

async function writeServerState({
  repoPath,
  outputDirName = ".openreview",
  state,
}: {
  repoPath: string;
  outputDirName?: string;
  state: TViewerControlServerState;
}): Promise<void> {
  const runtimeDir = getRuntimeDir({ repoPath, outputDirName });
  const statePath = getStatePath({ repoPath, outputDirName });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function isHealthy(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 2000,
      },
      (response) => {
        response.resume();
        resolve(
          (response.statusCode ?? 500) >= 200 &&
            (response.statusCode ?? 500) < 300,
        );
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

async function supportsBranchListing(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/control/git-branches",
        method: "GET",
        timeout: 2000,
      },
      (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) === 200);
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

function killProcess(pid: number | null): void {
  if (!(typeof pid === "number" && Number.isFinite(pid) && pid > 0)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore stale or already-exited pids.
  }
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Failed to allocate a viewer control port")),
        );
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveControlServerRunner({
  moduleDir,
}: {
  moduleDir: string;
}): Promise<{ runnerExecutable: string; runnerScriptPath: string }> {
  const tsRunnerPath = path.join(moduleDir, "run-control-server.ts");
  const localJsRunnerPath = path.join(moduleDir, "run-control-server.js");
  const distJsRunnerPath = path.resolve(
    moduleDir,
    "../../../dist/viewer/server/run-control-server.js",
  );
  const tsxPath = path.resolve(moduleDir, "../../../node_modules/.bin/tsx");

  if ((await pathExists(tsRunnerPath)) && (await pathExists(tsxPath))) {
    return {
      runnerExecutable: tsxPath,
      runnerScriptPath: tsRunnerPath,
    };
  }

  if (await pathExists(localJsRunnerPath)) {
    return {
      runnerExecutable: process.execPath,
      runnerScriptPath: localJsRunnerPath,
    };
  }

  if (await pathExists(distJsRunnerPath)) {
    return {
      runnerExecutable: process.execPath,
      runnerScriptPath: distJsRunnerPath,
    };
  }

  throw new Error(
    [
      "Could not locate a viewer control server runner.",
      `Checked: ${tsRunnerPath}`,
      `Checked: ${localJsRunnerPath}`,
      `Checked: ${distJsRunnerPath}`,
      `Checked: ${tsxPath}`,
    ].join("\n"),
  );
}

async function readLogExcerpt(logPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(logPath, "utf8");
    const excerpt = content.trim().split("\n").slice(-40).join("\n").trim();

    return excerpt || null;
  } catch {
    return null;
  }
}

export async function ensureViewerControlServer({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): Promise<number> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const codeVersion = await resolveViewerControlCodeVersion({ moduleDir });
  const existingState = await readServerState({ repoPath, outputDirName });
  if (
    existingState?.serverVersion === VIEWER_CONTROL_SERVER_VERSION &&
    existingState?.codeVersion === codeVersion &&
    existingState?.repoPath === repoPath &&
    existingState.outputDirName === outputDirName &&
    (await isHealthy(existingState.port)) &&
    (await supportsBranchListing(existingState.port))
  ) {
    return existingState.port;
  }

  killProcess(existingState?.pid ?? null);

  const port = await findAvailablePort();
  const runtimeDir = getRuntimeDir({ repoPath, outputDirName });
  await fs.mkdir(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, "viewer-control-server.log");
  await fs.writeFile(logPath, "", "utf8");
  const { runnerExecutable, runnerScriptPath } =
    await resolveControlServerRunner({ moduleDir });
  const launchCommand = [
    "nohup",
    shellQuote(runnerExecutable),
    shellQuote(runnerScriptPath),
    "--repo-path",
    shellQuote(repoPath),
    "--output-dir-name",
    shellQuote(outputDirName),
    "--port",
    String(port),
    `>>${shellQuote(logPath)}`,
    "2>&1",
    "</dev/null",
    "&",
    "printf '%s' $!",
  ].join(" ");
  const launchResult = spawnSync("sh", ["-lc", launchCommand], {
    encoding: "utf8",
    cwd: repoPath,
    env: process.env,
  });

  if (launchResult.status !== 0) {
    throw new Error(
      launchResult.stderr.trim() || "Failed to start viewer control server",
    );
  }

  const pid = Number.parseInt(launchResult.stdout.trim(), 10);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) {
      await writeServerState({
        repoPath,
        outputDirName,
        state: {
          codeVersion,
          serverVersion: VIEWER_CONTROL_SERVER_VERSION,
          pid: Number.isFinite(pid) ? pid : null,
          port,
          repoPath,
          outputDirName,
          startedAt: new Date().toISOString(),
        },
      });
      return port;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const logExcerpt = await readLogExcerpt(logPath);
  throw new Error(
    logExcerpt
      ? `Viewer control server did not become healthy in time.\n\n${logExcerpt}`
      : "Viewer control server did not become healthy in time",
  );
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-OpenReview-Control-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function hasValidControlToken(
  request: http.IncomingMessage,
  expectedToken: string,
): boolean {
  const providedToken = request.headers["x-openreview-control-token"];
  if (Array.isArray(providedToken)) {
    return providedToken.includes(expectedToken);
  }

  return providedToken === expectedToken;
}

function readGitBranches(repoPath: string): {
  branches: string[];
  currentBranch: string | null;
} {
  const branchResult = spawnSync(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ],
    {
      cwd: repoPath,
      encoding: "utf8",
    },
  );

  if (branchResult.status !== 0) {
    throw new Error(
      branchResult.stderr.trim() || "Failed to read git branches",
    );
  }

  const currentBranchResult = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoPath,
    encoding: "utf8",
  });

  if (currentBranchResult.status !== 0) {
    throw new Error(
      currentBranchResult.stderr.trim() || "Failed to read current git branch",
    );
  }

  const branches = branchResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.includes("HEAD ->"))
    .sort((left, right) => left.localeCompare(right));

  return {
    branches,
    currentBranch: currentBranchResult.stdout.trim() || null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type TViewerRefreshMode = "full" | "incremental";

type TViewerRefreshRequest = {
  mode: TViewerRefreshMode;
  compare?: TReviewCompare;
  scope?: TReviewScope;
};

function normalizeViewerRefreshMode(
  value: unknown,
): TViewerRefreshMode | null {
  if (value === "full" || value === "hard-reset") {
    return "full";
  }

  if (value === "incremental" || value === "reexamine") {
    return "incremental";
  }

  return null;
}

function normalizeViewerRefreshScope(
  value: unknown,
): TReviewScope | null {
  if (value === "branch" || value === "repo") {
    return value;
  }

  return null;
}

function parseRefreshRequest(body: unknown): TViewerRefreshRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  const mode = normalizeViewerRefreshMode(body.mode);
  if (!mode) {
    return null;
  }

  return {
    mode,
    ...(Object.hasOwn(body, "scope")
      ? (() => {
          const scope = normalizeViewerRefreshScope(body.scope);
          return scope ? { scope } : {};
        })()
      : {}),
    ...(Object.hasOwn(body, "compare")
      ? {
          compare: normalizeReviewCompare(
            isRecord(body.compare)
              ? body.compare
              : {
                  baseBranch: typeof body.compare === "string" ? body.compare : null,
                },
          ),
        }
      : {}),
  };
}

function normalizeRequestedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const next: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = entry.trim().replace(/^\.\//u, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    next.push(normalized);
  }

  return next;
}

function isProbablyTextFile(content: Buffer): boolean {
  const sample = content.subarray(0, 4096);
  return !sample.includes(0);
}

async function readRepoFileContext({
  repoPath,
  filePath,
}: {
  repoPath: string;
  filePath: string;
}): Promise<{ path: string; content: string } | null> {
  try {
    const resolvedRepoPath = await fs.realpath(repoPath);
    const resolvedPath = path.resolve(resolvedRepoPath, filePath);
    const realFilePath = await fs.realpath(resolvedPath);
    const relativePath = path.relative(resolvedRepoPath, realFilePath);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      return null;
    }

    const stat = await fs.stat(realFilePath);
    if (!stat.isFile()) {
      return null;
    }

    const content = await fs.readFile(realFilePath);
    if (!isProbablyTextFile(content)) {
      return null;
    }

    return {
      path: relativePath,
      content: content.toString("utf8").slice(0, 20000),
    };
  } catch {
    return null;
  }
}

function buildFixPromptWithFiles({
  prompt,
  fileContexts,
}: {
  prompt: string;
  fileContexts: Array<{ path: string; content: string }>;
}): string {
  const sections = [prompt.trim()];

  if (fileContexts.length > 0) {
    sections.push(
      [
        "Relevant repo files are included below as plain text context.",
        "Use them when editing, but verify details against the workspace before making changes.",
        ...fileContexts.map(
          (file) =>
            [`File: ${file.path}`, "```", file.content, "```"].join("\n"),
        ),
      ].join("\n\n"),
    );
  }

  return sections.filter(Boolean).join("\n\n");
}

async function resolveViewerIndexUrl({
  repoPath,
  outputDirName,
}: {
  repoPath: string;
  outputDirName: string;
}): Promise<string> {
  const viewerRoot = path.join(repoPath, outputDirName, "runtime", "viewer");

  try {
    const entries = await fs.readdir(viewerRoot, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const indexPath = path.join(viewerRoot, entry.name, "index.html");
          try {
            const stat = await fs.stat(indexPath);
            return stat.isFile()
              ? { indexPath, modifiedAt: stat.mtimeMs }
              : null;
          } catch {
            return null;
          }
        }),
    );

    const latestIndexPath = candidates
      .filter(
        (
          candidate,
        ): candidate is {
          indexPath: string;
          modifiedAt: number;
        } => candidate !== null,
      )
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.indexPath;

    if (latestIndexPath) {
      return pathToFileURL(latestIndexPath).toString();
    }
  } catch {
    // Fall back to the default workspace path below.
  }

  return pathToFileURL(
    path.join(viewerRoot, "workspace-default", "index.html"),
  ).toString();
}

async function readViewerStatus(port: number): Promise<{
  viewer: { controlToken?: string | null } | null;
} | null> {
  return await new Promise((resolve) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/control/status",
        method: "GET",
        timeout: 4000,
      },
      async (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              sessionDebug?: {
                viewer?: {
                  controlToken?: string | null;
                };
              };
            };
            resolve(
              payload?.sessionDebug?.viewer
                ? {
                    viewer: {
                      controlToken:
                        typeof payload.sessionDebug.viewer.controlToken ===
                        "string"
                          ? payload.sessionDebug.viewer.controlToken
                          : null,
                    },
                  }
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

export async function runViewerControlServer({
  repoPath,
  outputDirName = ".openreview",
  port,
}: {
  repoPath: string;
  outputDirName?: string;
  port: number;
}): Promise<void> {
  let reexamineState: "idle" | "running" | "error" = "idle";
  let lastError: string | null = null;
  const controlToken = randomUUID();

  const refreshViewer = async ({
    repoOutputDirName = outputDirName,
    controlPort = port,
    controlToken: nextControlToken = controlToken,
    compare,
  }: {
    repoOutputDirName?: string;
    controlPort?: number;
    controlToken?: string | null;
    compare?: TReviewCompare;
  } = {}): Promise<void> => {
    await syncCheckedInViewerAssets({ repoPath, outputDirName: repoOutputDirName });
    await syncViewerPayloads({
      repoPath,
      outputDirName: repoOutputDirName,
      controlPort,
      controlToken: nextControlToken,
      ...(compare !== undefined ? { compare } : {}),
    });
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-OpenReview-Control-Token",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/control/status") {
      const reviewDebug = await readJsonFile<Record<string, unknown> | null>({
        repoPath,
        outputDirName,
        fileName: "debug.json",
      });
      writeJson(response, 200, {
        viewer: {
          status: reexamineState === "running" ? "starting" : "running",
          controlPort: port,
          lastError,
        },
        sessionDebug: {
          viewer: {
            status: reexamineState === "running" ? "starting" : "running",
            controlPort: port,
            controlToken,
            lastError,
          },
        },
        reviewDebug,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/control/git-branches") {
      try {
        const { branches, currentBranch } = readGitBranches(repoPath);
        writeJson(response, 200, { branches, currentBranch });
      } catch (error) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/control/refresh") {
      if (!hasValidControlToken(request, controlToken)) {
        writeJson(response, 403, { error: "Missing or invalid control token." });
        return;
      }

      let refreshRequest: TViewerRefreshRequest | null = null;

      try {
        refreshRequest = parseRefreshRequest(
          JSON.parse(await readRequestBody(request)) as unknown,
        );
      } catch {
        writeJson(response, 400, { error: "Invalid JSON body." });
        return;
      }

      if (!refreshRequest) {
        writeJson(response, 400, {
          error: "Expected a JSON body with mode, optional compare, and optional scope.",
        });
        return;
      }

      if (reexamineState === "running") {
        if (refreshRequest.mode === "incremental") {
          writeJson(response, 202, { ok: true, queued: true });
          return;
        }

        writeJson(response, 409, {
          error: "A viewer refresh is already running. Wait for it to finish and try again.",
        });
        return;
      }

      const reviewCompare =
        refreshRequest.compare !== undefined
          ? normalizeReviewCompare(refreshRequest.compare)
          : undefined;
      const currentScope: TReviewScope =
        outputDirName === getReviewOutputDirName("repo") ? "repo" : "branch";
      const targetScope = refreshRequest.scope ?? currentScope;
      const targetOutputDirName = getReviewOutputDirName(targetScope);
      const shouldRedirectToTarget = targetOutputDirName !== outputDirName;
      const refreshCompare =
        targetScope === "branch" && refreshRequest.mode === "incremental"
          ? reviewCompare
          : undefined;

      if (targetScope === "repo" && refreshRequest.mode === "incremental") {
        writeJson(response, 400, {
          error: "Whole-repo review mode does not support incremental refresh.",
        });
        return;
      }

      reexamineState = "running";
      lastError = null;

      const runRefresh = async () => {
        try {
          await generateReview({
            repoPath,
            mode: refreshRequest.mode,
            scope: targetScope,
            ...(refreshCompare !== undefined ? { compare: refreshCompare } : {}),
          });
          if (shouldRedirectToTarget) {
            const targetPort = await ensureViewerControlServer({
              repoPath,
              outputDirName: targetOutputDirName,
            });
            const targetStatus = await readViewerStatus(targetPort);
            await refreshViewer({
              repoOutputDirName: targetOutputDirName,
              controlPort: targetPort,
              controlToken: targetStatus?.viewer?.controlToken ?? null,
              ...(refreshCompare !== undefined ? { compare: refreshCompare } : {}),
            });
          } else {
            await refreshViewer(
              refreshCompare !== undefined ? { compare: refreshCompare } : undefined,
            );
          }
          reexamineState = "idle";
          lastError = null;
        } catch (error) {
          reexamineState = "error";
          lastError =
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error);
          throw error;
        }
      };

      if (refreshRequest.mode === "incremental") {
        writeJson(response, 202, { ok: true });
        void runRefresh().catch(() => {});
        return;
      }

      try {
        await runRefresh();
        const nextUrl = shouldRedirectToTarget
          ? await resolveViewerIndexUrl({
              repoPath,
              outputDirName: targetOutputDirName,
            })
          : null;
        writeJson(response, 200, {
          ok: true,
          ...(nextUrl ? { nextUrl } : {}),
        });
      } catch {
        writeJson(response, 500, { error: lastError });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/control/fix-prompt") {
      if (!hasValidControlToken(request, controlToken)) {
        writeJson(response, 403, { error: "Missing or invalid control token." });
        return;
      }

      try {
        let body: unknown;
        try {
          body = JSON.parse(await readRequestBody(request)) as unknown;
        } catch {
          writeJson(response, 400, { error: "Invalid JSON body." });
          return;
        }

        if (!isRecord(body)) {
          writeJson(response, 400, { error: "Expected a JSON object body." });
          return;
        }

        const prompt =
          typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          writeJson(response, 400, { error: "Prompt is required." });
          return;
        }

        const resolvedRepoPath = await resolveRepoRoot(repoPath);
        const baseUrl = await ensureRepoOpenCodeServer({
          repoPath: resolvedRepoPath,
          outputDirName,
        });
        const config = resolveReviewConfig({ baseUrl, outputDirName });
        const requestedFiles = normalizeRequestedFiles(body.files);
        const fileContexts = (
          await Promise.all(
            requestedFiles.map((filePath) =>
              readRepoFileContext({ repoPath: resolvedRepoPath, filePath }),
            ),
          )
        ).filter((entry): entry is { path: string; content: string } => Boolean(entry));

        await runOpenCodePrompt({
          config,
          directory: resolvedRepoPath,
          prompt: buildFixPromptWithFiles({ prompt, fileContexts }),
        });

        writeJson(response, 200, {
          ok: true,
          includedFiles: fileContexts.map((file) => file.path),
          skippedFiles: requestedFiles.filter(
            (filePath) => !fileContexts.some((entry) => entry.path === filePath),
          ),
        });
      } catch (error) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  try {
    await refreshViewer();
    lastError = null;
  } catch (error) {
    lastError =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
}

async function readJsonFile<T>({
  repoPath,
  outputDirName = ".openreview",
  fileName,
}: {
  repoPath: string;
  outputDirName?: string;
  fileName: string;
}): Promise<T | null> {
  try {
    const targetPath = path.join(repoPath, outputDirName, fileName);
    const content = await fs.readFile(targetPath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}
