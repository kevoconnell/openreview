import fs from "node:fs/promises";
import path from "node:path";
import { OutputWriteError } from "../errors.js";
import type { TReviewConfig } from "../config/review-config.js";
import type { TRepoSnapshot } from "../collectors/repo-snapshot.js";
import type { TOpenCodeSessionDebug } from "../opencode/review-client.js";
import type { TReviewDocument } from "../schemas/review.js";

export type TArtifactPaths = {
  outputDir: string;
  overviewPath: string;
  fileInsightsPath: string;
  graphPath: string;
  debugPath: string;
};

export type TReviewDebugArtifact = {
  generatedAt: string;
  prompt: string;
  snapshot: {
    repoPath: string;
    repoName: string;
    compare: TRepoSnapshot["compare"];
    gitStatusSummary: string | null;
    recentCommits: string[];
    fileTree: string[];
    changedFiles: string[];
    impactedFiles: string[];
    files: TRepoSnapshot["files"];
  };
  openCode: TOpenCodeSessionDebug;
};

type TGraphNode = {
  id: string;
  type: "group" | "file";
  label: string;
  path: string;
  parentId: string | null;
  state: "changed" | "affected" | "unchanged";
  moduleBoundary?: string;
};

type TGraphEdge = {
  id: string;
  type: "structure" | "impact";
  source: string;
  target: string;
  reasons?: string[];
};

type TGraphDocument = {
  repoName: string;
  generatedAt: string;
  nodes: TGraphNode[];
  edges: TGraphEdge[];
};

function escapeMermaid(value: string): string {
  return value.replaceAll('"', "'");
}

function renderFunctionFindingsMarkdown(
  findings: TReviewDocument["files"][number]["functionFindings"],
): string[] {
  if (!findings.length) {
    return ["- None"];
  }

  return findings.flatMap((finding) => [
    `- ${finding.functionName} (${finding.priority})`,
    `  - Location: ${finding.location}`,
    `  - Before: ${finding.before}`,
    `  - Current: ${finding.current}`,
    `  - Simplification strategy: ${finding.simplificationStrategy}`,
    `  - Combine with: ${finding.combineWith.length ? finding.combineWith.join("; ") : "None"}`,
    `  - Problem: ${finding.problem}`,
    `  - Why confusing: ${finding.whyConfusing.join("; ")}`,
    `  - Better: ${finding.better}`,
    `  - Why better: ${finding.whyBetter}`,
    `  - Consumer impact: ${finding.consumerImpact}`,
    `  - Migration: ${finding.migrationNotes.length ? finding.migrationNotes.join("; ") : "None"}`,
  ]);
}

function buildMergedFiles({
  review,
  snapshot,
}: {
  review: TReviewDocument;
  snapshot: TRepoSnapshot;
}) {
  const reviewByPath = new Map(review.files.map((file) => [file.path, file]));

  const snapshotByPath = new Map(
    snapshot.files.map((file) => [file.path, file]),
  );
  const mergedPaths = [
    ...new Set([...snapshotByPath.keys(), ...reviewByPath.keys()]),
  ];

  return mergedPaths.map((relativePath) => {
    const snapshotFile = snapshotByPath.get(relativePath) ?? {
      path: relativePath,
      basename: path.basename(relativePath),
      excerpt: "",
      gitStatus: null,
      changeType: null,
      state: "affected" as const,
      impactSources: [],
      impactReasons: [],
      consumerPaths: [],
    };
    const reviewFile = reviewByPath.get(snapshotFile.path);
    return {
      path: snapshotFile.path,
      basename: snapshotFile.basename,
      state: snapshotFile.state,
      changeType: snapshotFile.changeType,
      impactSources: snapshotFile.impactSources,
      impactReasons: snapshotFile.impactReasons,
      consumerPaths: snapshotFile.consumerPaths ?? [],
      moduleBoundary:
        reviewFile?.moduleBoundary ??
        (snapshotFile.path.includes("bin/")
          ? "launch flow"
          : snapshotFile.path.includes("runtime")
            ? "runtime state"
            : snapshotFile.path.includes("src/")
              ? "application logic"
              : "repository support"),
      interfaceSummary:
        reviewFile?.interfaceSummary ??
        `${snapshotFile.basename} contains shared code in the current review graph.`,
      branchChange:
        reviewFile?.branchChange ??
        (snapshotFile.state === "changed"
          ? `${snapshotFile.path} is directly changed in the current review scope.`
          : `${snapshotFile.path} is included as surrounding impact context.`),
      callerImpact:
        reviewFile?.callerImpact ??
        (snapshotFile.state === "changed"
          ? `This file is a primary source of the current shared-interface change.`
          : snapshotFile.impactSources.length > 0
            ? `This file is affected by ${snapshotFile.impactSources.join(", ")} because of ${snapshotFile.impactReasons.join(", ")}.`
            : `This file provides surrounding caller context around the changed interface.`),
      extensibilitySummary:
        reviewFile?.extensibilitySummary ??
        (snapshotFile.state === "changed"
          ? `Changes here can directly alter how callers understand and use shared functions in this review.`
          : `Changes here can indirectly shift how callers rely on the changed functions.`),
      suggestedDirection:
        reviewFile?.suggestedDirection ??
        reviewFile?.functionFindings?.[0]?.fixPrompt ??
        "",
      interfaceTags: reviewFile?.interfaceTags ?? [],
      functionFindings: reviewFile?.functionFindings ?? [],
      summarySource: "same-prompt-openCode" as const,
    };
  });
}

function buildGraph({
  repoName,
  files,
}: {
  repoName: string;
  files: ReturnType<typeof buildMergedFiles>;
}): TGraphDocument {
  const nodes: TGraphNode[] = [];
  const edges: TGraphEdge[] = [];
  const groupIds = new Set<string>();

  const ensureGroup = (groupPath: string) => {
    if (groupIds.has(groupPath)) return;
    groupIds.add(groupPath);
    const parentPath = groupPath.includes("/")
      ? groupPath.split("/").slice(0, -1).join("/")
      : null;
    nodes.push({
      id: `group:${groupPath || repoName}`,
      type: "group",
      label: groupPath ? path.posix.basename(groupPath) : repoName,
      path: groupPath,
      parentId: parentPath ? `group:${parentPath}` : null,
      state: "unchanged",
    });
    if (parentPath) {
      ensureGroup(parentPath);
      edges.push({
        id: `structure:${parentPath}->${groupPath}`,
        type: "structure",
        source: `group:${parentPath}`,
        target: `group:${groupPath}`,
      });
    }
  };

  for (const file of files) {
    const directory = path.posix.dirname(file.path);
    const groupPath = directory === "." ? "" : directory;
    if (groupPath) {
      ensureGroup(groupPath);
    }

    const fileNodeId = `file:${file.path}`;
    nodes.push({
      id: fileNodeId,
      type: "file",
      label: file.basename,
      path: file.path,
      parentId: groupPath ? `group:${groupPath}` : null,
      state: file.state,
      moduleBoundary: file.moduleBoundary,
    });

    if (groupPath) {
      edges.push({
        id: `structure:${groupPath}->${file.path}`,
        type: "structure",
        source: `group:${groupPath}`,
        target: fileNodeId,
      });
    }

    for (const impactSource of file.impactSources) {
      edges.push({
        id: `impact:${impactSource}->${file.path}`,
        type: "impact",
        source: `file:${impactSource}`,
        target: fileNodeId,
        reasons: file.impactReasons,
      });
    }
  }

  return {
    repoName,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

function buildDebugArtifact({
  prompt,
  snapshot,
  openCode,
}: {
  prompt: string;
  snapshot: TRepoSnapshot;
  openCode: TOpenCodeSessionDebug;
}): TReviewDebugArtifact {
  return {
    generatedAt: new Date().toISOString(),
    prompt,
    snapshot: {
      repoPath: snapshot.repoPath,
      repoName: snapshot.repoName,
      compare: snapshot.compare,
      gitStatusSummary: snapshot.gitStatusSummary,
      recentCommits: snapshot.recentCommits,
      fileTree: snapshot.fileTree,
      changedFiles: snapshot.changedFiles,
      impactedFiles: snapshot.impactedFiles,
      files: snapshot.files,
    },
    openCode,
  };
}

export async function writeDebugArtifact({
  repoPath,
  config,
  prompt,
  snapshot,
  openCode,
}: {
  repoPath: string;
  config: TReviewConfig;
  prompt: string;
  snapshot: TRepoSnapshot;
  openCode: TOpenCodeSessionDebug;
}): Promise<string> {
  const outputDir = path.join(repoPath, config.outputDirName);
  const debugPath = path.join(outputDir, "debug.json");
  const debugArtifact = buildDebugArtifact({
    prompt,
    snapshot,
    openCode,
  });

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      debugPath,
      `${JSON.stringify(debugArtifact, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw new OutputWriteError(
      "Failed to write review debug artifact",
      { outputDir },
      { cause: error as Error },
    );
  }

  return debugPath;
}

function renderOverviewMarkdown({
  review,
  mergedFiles,
}: {
  review: TReviewDocument;
  mergedFiles: ReturnType<typeof buildMergedFiles>;
}): string {
  const changedFiles = mergedFiles.filter((file) => file.state === "changed");
  const impactedFiles = mergedFiles.filter((file) => file.state === "affected");
  const componentNodes = review.overview.keyModules
    .map(
      (component, index) =>
        `  component_${index}["${escapeMermaid(component)}"]`,
    )
    .join("\n");
  const changeNodes = changedFiles
    .map(
      (file, index) =>
        `  changed_${index}["${escapeMermaid(file.basename)}"]:::changed`,
    )
    .join("\n");
  const impactedNodes = impactedFiles
    .map(
      (file, index) =>
        `  impacted_${index}["${escapeMermaid(file.basename)}"]:::impacted`,
    )
    .join("\n");
  const changedEdges = changedFiles
    .map(
      (file, index) =>
        `  repo["${escapeMermaid(review.overview.repoName)}"] --> changed_${index}`,
    )
    .join("\n");
  const impactedEdges = impactedFiles
    .flatMap((file, impactedIndex) =>
      (file.impactSources.length > 0
        ? file.impactSources
        : changedFiles.map((changedFile) => changedFile.path)
      )
        .slice(0, 3)
        .map((impactSource) => {
          const changedIndex = changedFiles.findIndex(
            (changedFile) => changedFile.path === impactSource,
          );
          const sourceNode =
            changedIndex >= 0
              ? `changed_${changedIndex}`
              : `repo["${escapeMermaid(review.overview.repoName)}"]`;
          return `  ${sourceNode} -.-> impacted_${impactedIndex}`;
        }),
    )
    .join("\n");

  const fileSection = mergedFiles
    .map((file) =>
      [
        `### \`${file.path}\``,
        `- State: ${file.state}`,
        `- Module boundary: ${file.moduleBoundary}`,
        `- Interface summary: ${file.interfaceSummary}`,
        `- Branch change: ${file.branchChange}`,
        `- Caller impact: ${file.callerImpact}`,
        `- Extensibility summary: ${file.extensibilitySummary}`,
        `- Suggested direction: ${file.suggestedDirection}`,
        file.interfaceTags.length > 0
          ? `- Interface tags: ${file.interfaceTags.join(", ")}`
          : "- Interface tags: none",
        "- Function findings:",
        ...renderFunctionFindingsMarkdown(file.functionFindings),
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `# ${review.overview.repoName}`,
    "",
    `- Project type: ${review.overview.projectType}`,
    `- Domain: ${review.overview.domain}`,
    "",
    "```mermaid",
    "flowchart LR",
    `  repo[\"${escapeMermaid(review.overview.repoName)}\"]:::repo`,
    componentNodes,
    changeNodes,
    impactedNodes,
    review.overview.keyModules
      .map((component, index) => `  repo --> component_${index}`)
      .join("\n"),
    changedEdges,
    impactedEdges,
    "  classDef repo fill:#0f172a,stroke:#38bdf8,color:#e2e8f0,stroke-width:2px;",
    "  classDef changed fill:#1d4ed8,stroke:#93c5fd,color:#eff6ff,stroke-width:3px;",
    "  classDef impacted fill:#1e293b,stroke:#f59e0b,color:#fde68a,stroke-dasharray: 5 3;",
    "```",
    "",
    "## Interface review summary",
    review.overview.reviewSummary,
    "",
    `## Changed files (${changedFiles.length})`,
    ...(changedFiles.length > 0
      ? changedFiles.map((file) => `- \`${file.path}\` — ${file.branchChange}`)
      : ["- None"]),
    "",
    `## Affected files (${impactedFiles.length})`,
    ...(impactedFiles.length > 0
      ? impactedFiles.map((file) => `- \`${file.path}\` — ${file.callerImpact}`)
      : ["- None"]),
    "",
    "## Interface patterns",
    ...review.overview.interfacePatterns.map((pattern) => `- ${pattern}`),
    "",
    "## Key modules and boundaries",
    ...review.overview.keyModules.map((component) => `- ${component}`),
    "",
    "## Function interface findings by file",
    fileSection,
    "",
  ].join("\n");
}

export async function writeArtifacts({
  repoPath,
  config,
  review,
  snapshot,
  prompt,
  openCode,
}: {
  repoPath: string;
  config: TReviewConfig;
  review: TReviewDocument;
  snapshot: TRepoSnapshot;
  prompt: string;
  openCode: TOpenCodeSessionDebug;
}): Promise<TArtifactPaths> {
  const outputDir = path.join(repoPath, config.outputDirName);
  const overviewPath = path.join(outputDir, "overview.md");
  const fileInsightsPath = path.join(outputDir, "file-insights.json");
  const graphPath = path.join(outputDir, "graph.json");
  const debugPath = path.join(outputDir, "debug.json");
  const mergedFiles = buildMergedFiles({ review, snapshot });
  const graph = buildGraph({
    repoName: review.overview.repoName,
    files: mergedFiles,
  });
  const debugArtifact = buildDebugArtifact({
    prompt,
    snapshot,
    openCode,
  });

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      overviewPath,
      renderOverviewMarkdown({ review, mergedFiles }),
      "utf8",
    );
    await fs.writeFile(
      fileInsightsPath,
      `${JSON.stringify(mergedFiles, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      graphPath,
      `${JSON.stringify(graph, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      debugPath,
      `${JSON.stringify(debugArtifact, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw new OutputWriteError(
      "Failed to write review artifacts",
      { outputDir },
      { cause: error as Error },
    );
  }

  return {
    outputDir,
    overviewPath,
    fileInsightsPath,
    graphPath,
    debugPath,
  };
}
