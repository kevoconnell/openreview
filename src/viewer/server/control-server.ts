import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReviewConfig } from "../../config/review-config.js";
import { runOpenCodePrompt } from "../../opencode/review-client.js";
import { ensureRepoOpenCodeServer, resolveRepoRoot } from "../../opencode/server.js";
import { generateReview } from "../../pipeline/generate-review.js";
import { syncCheckedInViewerAssets } from "../build/sync-assets.js";
import { syncViewerPayloads } from "../data/sync-payloads.js";

type TViewerControlServerState = {
  pid: number | null;
  port: number;
  repoPath: string;
  outputDirName: string;
  startedAt: string;
};

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
    "../../dist/viewer/server/run-control-server.js",
  );
  const tsxPath = path.resolve(moduleDir, "../../node_modules/.bin/tsx");

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
  const existingState = await readServerState({ repoPath, outputDirName });
  if (
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
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
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

function normalizeOptionalBranchName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseReexamineRequest(body: unknown): {
  baseBranch: string | null;
  headBranch: string | null;
} {
  if (!isRecord(body)) {
    return {
      baseBranch: null,
      headBranch: null,
    };
  }

  return {
    baseBranch: normalizeOptionalBranchName(body.baseBranch),
    headBranch: normalizeOptionalBranchName(body.headBranch ?? body.compareBranch),
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
    baseBranch,
    headBranch,
  }: {
    baseBranch?: string | null;
    headBranch?: string | null;
  } = {}): Promise<void> => {
    await syncCheckedInViewerAssets({ repoPath, outputDirName });
    await syncViewerPayloads({
      repoPath,
      outputDirName,
      controlPort: port,
      controlToken,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(headBranch !== undefined ? { headBranch } : {}),
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

    if (request.method === "POST" && url.pathname === "/control/reexamine") {
      if (!hasValidControlToken(request, controlToken)) {
        writeJson(response, 403, { error: "Missing or invalid control token." });
        return;
      }

      let reexamineRequest: { baseBranch: string | null; headBranch: string | null } = {
        baseBranch: null,
        headBranch: null,
      };

      try {
        const rawBody = await readRequestBody(request);
        if (rawBody.trim()) {
          reexamineRequest = parseReexamineRequest(JSON.parse(rawBody) as unknown);
        }
      } catch {
        writeJson(response, 400, { error: "Invalid JSON body." });
        return;
      }

      if (reexamineState === "running") {
        writeJson(response, 202, { ok: true, queued: true });
        return;
      }

      reexamineState = "running";
      lastError = null;
      writeJson(response, 202, { ok: true });

      void (async () => {
        try {
          await generateReview({
            repoPath,
            mode: "incremental",
            baseBranch: reexamineRequest.baseBranch,
            headBranch: reexamineRequest.headBranch,
          });
          await refreshViewer(reexamineRequest);
          reexamineState = "idle";
          lastError = null;
        } catch (error) {
          reexamineState = "error";
          lastError =
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error);
        }
      })();
      return;
    }

    if (request.method === "POST" && url.pathname === "/control/hard-reset") {
      if (!hasValidControlToken(request, controlToken)) {
        writeJson(response, 403, { error: "Missing or invalid control token." });
        return;
      }

      await readRequestBody(request);

      if (reexamineState === "running") {
        writeJson(response, 409, {
          error: "A viewer refresh is already running. Wait for it to finish and try again.",
        });
        return;
      }

      reexamineState = "running";
      lastError = null;

      try {
        await generateReview({ repoPath, mode: "full" });
        await refreshViewer();
        reexamineState = "idle";
        lastError = null;
        writeJson(response, 200, { ok: true });
      } catch (error) {
        reexamineState = "error";
        lastError =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
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
