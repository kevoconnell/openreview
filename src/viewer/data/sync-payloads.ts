import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

type TViewerPayload = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readGit(repoPath: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trimEnd();
}

function normalizeDiffStatus(rawStatus: unknown): string {
  const statusCode = String(rawStatus ?? "").trim().charAt(0).toUpperCase();
  switch (statusCode) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

function upsertReviewDiffFile(
  filesByPath: Map<string, Record<string, unknown>>,
  filePath: string,
  nextFields: Record<string, unknown>,
): void {
  const normalizedPath = String(filePath ?? "").trim().replace(/^\.\//u, "");
  if (!normalizedPath) {
    return;
  }

  filesByPath.set(normalizedPath, {
    path: normalizedPath,
    status: "modified",
    insertions: 0,
    deletions: 0,
    ...(filesByPath.get(normalizedPath) ?? {}),
    ...nextFields,
  });
}

function buildViewerReviewDiff({
  repoPath,
  existingReviewDiff,
  baseBranch,
  headBranch,
}: {
  repoPath: string;
  existingReviewDiff: unknown;
  baseBranch?: string | null;
  headBranch?: string | null;
}): Record<string, unknown> | null {
  const currentReviewDiff = isRecord(existingReviewDiff) ? existingReviewDiff : {};
  const resolvedBaseBranch =
    normalizeOptionalText(baseBranch) ??
    normalizeOptionalText(currentReviewDiff.baseLabel);
  const resolvedHeadBranch =
    normalizeOptionalText(headBranch) ??
    normalizeOptionalText(readGit(repoPath, ["branch", "--show-current"])) ??
    normalizeOptionalText(currentReviewDiff.currentBranch);

  if (!resolvedBaseBranch && !Object.keys(currentReviewDiff).length) {
    return null;
  }

  const filesByPath = new Map<string, Record<string, unknown>>();
  const diffRange = resolvedBaseBranch
    ? `${resolvedBaseBranch}...${resolvedHeadBranch ?? "HEAD"}`
    : null;
  const diffNameStatus = diffRange
    ? readGit(repoPath, ["diff", "--name-status", "--find-renames", diffRange])
    : null;
  const diffNumstat = diffRange
    ? readGit(repoPath, ["diff", "--numstat", "--find-renames", diffRange])
    : null;
  const statusShort = readGit(repoPath, ["status", "--short"]);
  const mergeBase =
    resolvedBaseBranch && resolvedHeadBranch
      ? normalizeOptionalText(
          readGit(repoPath, ["merge-base", resolvedBaseBranch, resolvedHeadBranch]),
        )
      : normalizeOptionalText(currentReviewDiff.mergeBase);

  for (const line of (diffNameStatus ?? "").split("\n")) {
    const [rawStatus, ...rawPathParts] = line.trim().split(/\s+/u);
    const diffPath = rawPathParts.at(-1)?.trim();
    if (!rawStatus || !diffPath) {
      continue;
    }

    upsertReviewDiffFile(filesByPath, diffPath, {
      status: normalizeDiffStatus(rawStatus),
    });
  }

  for (const line of (diffNumstat ?? "").split("\n")) {
    const [rawInsertions, rawDeletions, ...rawPathParts] = line.split("\t");
    const diffPath = rawPathParts.at(-1)?.trim();
    if (!diffPath) {
      continue;
    }

    upsertReviewDiffFile(filesByPath, diffPath, {
      insertions: Number.isFinite(Number(rawInsertions))
        ? Number(rawInsertions)
        : 0,
      deletions: Number.isFinite(Number(rawDeletions))
        ? Number(rawDeletions)
        : 0,
    });
  }

  for (const line of (statusShort ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const rawStatus = trimmed.slice(0, 2).trim() || "??";
    const diffPath = trimmed.slice(3).split(" -> ").at(-1)?.trim();
    if (!diffPath) {
      continue;
    }

    upsertReviewDiffFile(filesByPath, diffPath, {
      status: normalizeDiffStatus(rawStatus),
    });
  }

  const existingComparisons = isRecord(currentReviewDiff.comparisons)
    ? currentReviewDiff.comparisons
    : {};
  const nextComparisons = {
    ...existingComparisons,
    ...(resolvedBaseBranch
      ? {
          [resolvedBaseBranch]: {
            files: Array.from(filesByPath.values()),
            mergeBase,
          },
        }
      : {}),
  };
  const nextCompareOptions = Array.from(
    new Set(
      [
        ...(Array.isArray(currentReviewDiff.compareOptions)
          ? currentReviewDiff.compareOptions
          : []),
        ...Object.keys(existingComparisons),
        resolvedBaseBranch,
      ]
        .map((value) => normalizeOptionalText(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  return {
    ...currentReviewDiff,
    ...(resolvedBaseBranch ? { baseLabel: resolvedBaseBranch } : {}),
    ...(resolvedHeadBranch ? { currentBranch: resolvedHeadBranch } : {}),
    ...(mergeBase ? { mergeBase } : {}),
    files: Array.from(filesByPath.values()),
    compareOptions: nextCompareOptions,
    comparisons: nextComparisons,
  };
}

function getOutputDir({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(repoPath, outputDirName);
}

function getViewerRoot({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(getOutputDir({ repoPath, outputDirName }), "runtime", "viewer");
}

async function listViewerHtmlPaths({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): Promise<string[]> {
  const viewerRoot = getViewerRoot({ repoPath, outputDirName });

  let entryNames: string[] = [];
  try {
    entryNames = await fs.readdir(viewerRoot);
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    entryNames.map(async (entryName) => {
      const workspaceDir = path.join(viewerRoot, entryName);

      let fileNames: string[] = [];
      try {
        const stat = await fs.stat(workspaceDir);
        if (!stat.isDirectory()) {
          return [];
        }
        fileNames = await fs.readdir(workspaceDir);
      } catch {
        return [];
      }

      const htmlPaths = await Promise.all(
        fileNames
          .filter((fileName) => fileName.endsWith(".html"))
          .map(async (fileName) => {
            const htmlPath = path.join(workspaceDir, fileName);
            try {
              const stat = await fs.stat(htmlPath);
              return stat.isFile() ? htmlPath : null;
            } catch {
              return null;
            }
          }),
      );

      return htmlPaths.filter(
        (htmlPath): htmlPath is string => htmlPath !== null,
      );
    }),
  );

  return candidates.flat();
}

function getArtifactsPaths({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}) {
  const outputDir = getOutputDir({ repoPath, outputDirName });
  return {
    overviewPath: path.join(outputDir, "overview.md"),
    fileInsightsPath: path.join(outputDir, "file-insights.json"),
    graphPath: path.join(outputDir, "graph.json"),
    debugPath: path.join(outputDir, "debug.json"),
  };
}

async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(targetPath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readTextFile(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

function parseViewerPayload(html: string): TViewerPayload | null {
  const match = html.match(
    /<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/u,
  );
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as TViewerPayload;
  } catch {
    return null;
  }
}

function serializeViewerPayload({
  html,
  payload,
}: {
  html: string;
  payload: TViewerPayload;
}): string {
  const safePayloadJson = JSON.stringify(payload)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return html.replace(
    /<script id="viewer-data" type="application\/json">[\s\S]*?<\/script>/u,
    () =>
      `<script id="viewer-data" type="application/json">${safePayloadJson}</script>`,
  );
}

function patchBootstrapErrorRenderer(html: string): string {
  return html;
}

function toFileInsightsIndex(files: Array<Record<string, unknown>>) {
  return {
    generatedAt: new Date().toISOString(),
    files: Object.fromEntries(
      files.map((file) => [String(file.path ?? ""), file]),
    ),
  };
}

function deriveChangedInterfaces(files: Array<Record<string, unknown>>) {
  const entries = new Map<string, Record<string, unknown>>();

  for (const file of files) {
    const filePath = String(file.path ?? "");
    const findings = Array.isArray(file.functionFindings)
      ? file.functionFindings
      : [];
    for (const finding of findings) {
      if (!finding || typeof finding !== "object") {
        continue;
      }
      const functionName = String(
        (finding as Record<string, unknown>).functionName ?? "",
      );
      if (!filePath || !functionName) {
        continue;
      }
      const key = `${filePath}:${functionName}`;
      entries.set(key, {
        path: filePath,
        sourceOfTruthPath: filePath,
        mergedPaths: [filePath],
        name: functionName,
        declaration: String((finding as Record<string, unknown>).current ?? ""),
        currentDeclaration: String(
          (finding as Record<string, unknown>).current ?? "",
        ),
        snippet: String((finding as Record<string, unknown>).current ?? ""),
        consumers: [],
        consumerParts: [],
      });
    }
  }

  return Array.from(entries.values());
}

function buildStatusText(generatedAt: string): string {
  return `Updated ${new Date(generatedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

export async function syncViewerPayloads({
  repoPath,
  controlPort,
  controlToken,
  baseBranch,
  headBranch,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  controlPort: number;
  controlToken?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  outputDirName?: string;
}): Promise<number> {
  const htmlPaths = await listViewerHtmlPaths({ repoPath, outputDirName });
  if (!htmlPaths.length) {
    return 0;
  }

  const artifactPaths = getArtifactsPaths({ repoPath, outputDirName });
  const [markdown, fileInsightsArray, graphDocument, reviewDebug] =
    await Promise.all([
      readTextFile(artifactPaths.overviewPath),
      readJsonFile<Array<Record<string, unknown>>>(artifactPaths.fileInsightsPath),
      readJsonFile<Record<string, unknown>>(artifactPaths.graphPath),
      readJsonFile<Record<string, unknown>>(artifactPaths.debugPath),
    ]);

  const fileInsights = fileInsightsArray
    ? toFileInsightsIndex(fileInsightsArray)
    : null;
  const changedInterfaces = fileInsightsArray
    ? deriveChangedInterfaces(fileInsightsArray)
    : null;
  const generatedAt = String(
    reviewDebug?.generatedAt ?? new Date().toISOString(),
  );

  await Promise.all(
    htmlPaths.map(async (htmlPath) => {
      const html = await fs.readFile(htmlPath, "utf8");
      const existingPayload = parseViewerPayload(html) ?? {};
      const existingSessionDebug = (existingPayload.sessionDebug ??
        {}) as Record<string, unknown>;
      const existingViewerDebug = (existingSessionDebug.viewer ?? {}) as Record<
        string,
        unknown
      >;
      const reviewDiff = buildViewerReviewDiff({
        repoPath,
        existingReviewDiff: existingPayload.reviewDiff,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
        ...(headBranch !== undefined ? { headBranch } : {}),
      });

      const nextPayload: TViewerPayload = {
        ...existingPayload,
        pageType: "overview",
        worktreePath: repoPath,
        generatedAt,
        statusText: buildStatusText(generatedAt),
        ...(markdown !== null ? { markdown } : {}),
        ...(fileInsights !== null ? { fileInsightsIndex: fileInsights } : {}),
        ...(graphDocument !== null ? { graphDocument } : {}),
        ...(reviewDebug !== null ? { reviewDebug } : {}),
        ...(changedInterfaces !== null ? { changedInterfaces } : {}),
        ...(reviewDiff ? { reviewDiff } : {}),
        sessionDebug: {
          ...existingSessionDebug,
          viewer: {
            ...existingViewerDebug,
            controlPort,
            controlToken:
              typeof controlToken === "string"
                ? controlToken
                : existingViewerDebug.controlToken ?? null,
            status: "running",
            lastError: null,
          },
        },
      };

      const nextHtml = patchBootstrapErrorRenderer(
        serializeViewerPayload({ html, payload: nextPayload }),
      );

      await fs.writeFile(htmlPath, nextHtml, "utf8");
    }),
  );

  return htmlPaths.length;
}
