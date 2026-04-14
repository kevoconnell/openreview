import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  normalizeReviewCompare,
  resolveReviewCompare,
  type TReviewCompare,
} from "../../schemas/review-range.js";
import {
  getPrimaryRepoPartIdForPath,
  REPO_PARTS_BY_ID,
} from "../app/services/architecture.js";

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
  compare,
}: {
  repoPath: string;
  existingReviewDiff: unknown;
  compare?: Partial<TReviewCompare> | null;
}): Record<string, unknown> | null {
  const currentReviewDiff = isRecord(existingReviewDiff) ? existingReviewDiff : {};
  const currentCompare = normalizeReviewCompare(
    isRecord(currentReviewDiff.compare)
      ? currentReviewDiff.compare
      : {
          baseBranch: currentReviewDiff.baseLabel,
          headBranch: currentReviewDiff.currentBranch,
        },
  );
  const resolvedCompare = resolveReviewCompare(compare ?? currentCompare, {
    headBranch:
      normalizeOptionalText(readGit(repoPath, ["branch", "--show-current"])) ??
      currentCompare.headBranch,
  });
  const resolvedBaseBranch = resolvedCompare.baseBranch;
  const resolvedHeadBranch = resolvedCompare.headBranch;
  const currentMergeBase =
    isRecord(currentReviewDiff.compare) && "mergeBase" in currentReviewDiff.compare
      ? normalizeOptionalText(currentReviewDiff.compare.mergeBase)
      : normalizeOptionalText(currentReviewDiff.mergeBase);

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
      : currentMergeBase;

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

  const {
    baseLabel: _baseLabel,
    currentBranch: _currentBranch,
    mergeBase: _mergeBase,
    ...remainingReviewDiff
  } = currentReviewDiff;

  return {
    ...remainingReviewDiff,
    compare: {
      ...resolvedCompare,
      mergeBase,
    },
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

function getConsumerPartLabel(filePath: string): string | null {
  const partId = getPrimaryRepoPartIdForPath(filePath);
  return partId ? (REPO_PARTS_BY_ID[partId]?.label ?? null) : null;
}

function buildConsumerPreview(file: Record<string, unknown>): string {
  const impactReasons = Array.isArray(file.impactReasons)
    ? file.impactReasons
        .map((reason) => normalizeOptionalText(reason))
        .filter(Boolean)
    : [];
  const callerImpact = normalizeOptionalText(file.callerImpact);
  const reasonText = impactReasons.length
    ? impactReasons.slice(0, 2).join(", ")
    : callerImpact;
  const consumerState = String(file.state ?? "affected") === "changed"
    ? "Changed consumer"
    : "Affected consumer";

  return reasonText ? `${consumerState} · ${reasonText}` : consumerState;
}

function mergeConsumers(consumers: Array<Record<string, unknown>>) {
  const next = new Map<string, Record<string, unknown>>();

  for (const consumer of consumers) {
    const consumerPath = normalizeOptionalText(consumer.path);
    if (!consumerPath) {
      continue;
    }

    const existing = next.get(consumerPath);
    const reasons = [
      ...(Array.isArray(existing?.reasons) ? existing.reasons : []),
      ...(Array.isArray(consumer.reasons) ? consumer.reasons : []),
    ]
      .map((reason) => normalizeOptionalText(reason))
      .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
    const state =
      existing?.state === "changed" || consumer.state === "changed"
        ? "changed"
        : "affected";

    next.set(consumerPath, {
      ...(existing ?? {}),
      ...consumer,
      path: consumerPath,
      state,
      reasons,
      preview:
        String(consumer.preview ?? "").length >=
        String(existing?.preview ?? "").length
          ? consumer.preview
          : existing?.preview,
    });
  }

  return Array.from(next.values()).sort((left, right) => {
    const leftRank = left.state === "changed" ? 0 : 1;
    const rightRank = right.state === "changed" ? 0 : 1;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return String(left.path ?? "").localeCompare(String(right.path ?? ""));
  });
}

function deriveChangedInterfaces(files: Array<Record<string, unknown>>) {
  const entries = new Map<string, Record<string, unknown>>();
  const consumersBySourcePath = new Map<string, Array<Record<string, unknown>>>();
  const filesByPath = new Map(
    files.map((file) => [String(file.path ?? ""), file]),
  );

  const upsertConsumer = (
    sourcePath: string,
    consumerPath: string,
    fallbackFile: Record<string, unknown> | null = null,
  ) => {
    const consumerFile = filesByPath.get(consumerPath) ?? fallbackFile ?? { path: consumerPath };
    const existing = consumersBySourcePath.get(sourcePath) ?? [];
    existing.push({
      path: consumerPath,
      part: getConsumerPartLabel(consumerPath),
      preview: buildConsumerPreview(consumerFile),
      state: String(consumerFile.state ?? "affected"),
      reasons: Array.isArray(consumerFile.impactReasons)
        ? consumerFile.impactReasons
        : [],
    });
    consumersBySourcePath.set(sourcePath, existing);
  };

  for (const file of files) {
    const consumerPath = normalizeOptionalText(file.path);
    const consumerPaths = Array.isArray(file.consumerPaths)
      ? file.consumerPaths
          .map((value) => normalizeOptionalText(value))
          .filter((value): value is string => Boolean(value))
      : [];
    const impactSources = Array.isArray(file.impactSources)
      ? file.impactSources
          .map((impactSource) => normalizeOptionalText(impactSource))
          .filter((impactSource): impactSource is string => Boolean(impactSource))
      : [];

    if (!consumerPath) {
      continue;
    }

    for (const targetConsumerPath of consumerPaths) {
      upsertConsumer(consumerPath, targetConsumerPath, filesByPath.get(targetConsumerPath) ?? null);
    }
    for (const impactSource of impactSources) {
      upsertConsumer(impactSource, consumerPath, file);
    }
  }

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
      const consumers = mergeConsumers(consumersBySourcePath.get(filePath) ?? []);
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
        consumers,
        consumerParts: [
          ...new Set(
            consumers
              .map((consumer) => normalizeOptionalText(consumer.part))
              .filter(Boolean),
          ),
        ],
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
  compare,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  controlPort: number;
  controlToken?: string | null;
  compare?: Partial<TReviewCompare> | null;
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
        ...(compare !== undefined ? { compare } : {}),
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
