import fs from "node:fs/promises";
import path from "node:path";

type TViewerPayload = Record<string, unknown>;

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
  outputDirName = ".openreview",
}: {
  repoPath: string;
  controlPort: number;
  controlToken?: string | null;
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
