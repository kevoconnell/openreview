// @ts-nocheck

export const normalizeFileReference = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^\.\//u, "")
    .replace(/[)\],:;]+$/gu, "")
    .replace(/^file:\/\//u, "");

export function mapInterfaceFindingSeverity(value) {
  return value === "critical" || value === "high"
    ? "risk"
    : value === "medium"
      ? "warning"
      : "info";
}

function normalizeFunctionFinding(finding) {
  if (!finding) {
    return null;
  }
  const suggestions = Array.isArray(finding.suggestions)
    ? finding.suggestions
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          label: entry.label,
          better: entry.better,
          whyBetter: entry.whyBetter,
          tradeoff: entry.tradeoff,
        }))
        .filter((entry) => entry.label || entry.better || entry.whyBetter)
    : [];
  return {
    functionName: finding.functionName,
    location: finding.location,
    before: finding.before,
    current: finding.current,
    simplificationStrategy: finding.simplificationStrategy || "stabilize",
    combineWith: Array.isArray(finding.combineWith)
      ? finding.combineWith.filter(Boolean)
      : [],
    problem: finding.problem,
    whyConfusing: finding.whyConfusing ?? [],
    consumerImpact: finding.consumerImpact,
    better: finding.better,
    whyBetter: finding.whyBetter,
    suggestions,
    migrationNotes: finding.migrationNotes ?? [],
    priority: finding.priority ?? "medium",
    fixPrompt: finding.fixPrompt ?? "",
  };
}

export function isCombineOpportunity(finding) {
  return (
    finding?.simplificationStrategy === "combine" ||
    (Array.isArray(finding?.combineWith) && finding.combineWith.length > 0)
  );
}

export function dedupeBy(items, getKey) {
  const next = new Map();
  for (const item of items ?? []) {
    if (!item) {
      continue;
    }
    next.set(getKey(item), item);
  }
  return Array.from(next.values());
}

function buildLogicalPathSet({
  fileInsights,
  changedInterfaces,
  graphDocument,
}) {
  return new Set(
    [
      ...Object.values(fileInsights ?? {}).map((insight) =>
        normalizeFileReference(insight?.path ?? ""),
      ),
      ...(changedInterfaces ?? []).flatMap((item) => [
        normalizeFileReference(item?.path ?? ""),
        ...(item?.consumers ?? []).map((consumer) =>
          normalizeFileReference(consumer?.path ?? ""),
        ),
      ]),
      ...(graphDocument?.nodes ?? []).map((node) =>
        normalizeFileReference(node?.path ?? ""),
      ),
    ].filter(Boolean),
  );
}

function normalizeFileInsightsIndex(fileInsights, allPaths) {
  const next = new Map();

  for (const insight of Object.values(fileInsights ?? {})) {
    if (!insight?.path) {
      continue;
    }

    const logicalPath = getLogicalPath(insight.path, allPaths);
    const normalizedInsight = normalizeInsight({
      ...insight,
      path: logicalPath,
      sourceOfTruthPath: logicalPath,
      mergedPaths: [normalizeFileReference(insight.path)],
      basename:
        logicalPath.split("/").filter(Boolean).slice(-1)[0] ?? insight.basename,
    });

    const existing = next.get(logicalPath);
    next.set(
      logicalPath,
      !existing
        ? normalizedInsight
        : {
            ...(normalizeFileReference(insight.path) === logicalPath
              ? normalizedInsight
              : existing),
            sourceOfTruthPath: logicalPath,
            mergedPaths: dedupeBy(
              [
                ...(existing.mergedPaths ?? [existing.path]),
                normalizeFileReference(insight.path),
              ],
              (value) => value,
            ),
          },
    );
  }

  return Object.fromEntries(
    Array.from(next.values()).map((insight) => [insight.path, insight]),
  );
}

function normalizeChangedInterfaces(changedInterfaces, allPaths) {
  const next = new Map();

  for (const item of changedInterfaces ?? []) {
    if (!item?.path || !item?.name) {
      continue;
    }

    const logicalPath = getLogicalPath(item.path, allPaths);
    const key = `${logicalPath}:${item.name}`;
    const normalizedConsumers = dedupeBy(
      (item.consumers ?? []).map((consumer) => ({
        ...consumer,
        path: getLogicalPath(consumer.path, allPaths),
      })),
      (consumer) => `${consumer.path}:${consumer.preview ?? ""}`,
    );
    const existing = next.get(key);

    next.set(key, {
      ...(existing ?? {}),
      ...item,
      path: logicalPath,
      sourceOfTruthPath: logicalPath,
      mergedPaths: dedupeBy(
        [...(existing?.mergedPaths ?? []), normalizeFileReference(item.path)],
        (value) => value,
      ),
      declaration:
        item.declaration?.length > (existing?.declaration?.length ?? 0)
          ? item.declaration
          : (existing?.declaration ?? item.declaration),
      snippet:
        item.snippet?.length > (existing?.snippet?.length ?? 0)
          ? item.snippet
          : (existing?.snippet ?? item.snippet),
      currentDeclaration:
        item.currentDeclaration?.length >
        (existing?.currentDeclaration?.length ?? 0)
          ? item.currentDeclaration
          : (existing?.currentDeclaration ?? item.currentDeclaration),
      consumers: dedupeBy(
        [...(existing?.consumers ?? []), ...normalizedConsumers],
        (consumer) => `${consumer.path}:${consumer.preview ?? ""}`,
      ),
      consumerParts: [
        ...new Set([
          ...(existing?.consumerParts ?? []),
          ...(item.consumerParts ?? []),
        ]),
      ],
    });
  }

  return Array.from(next.values());
}

export function getCollapsedAliasPaths(entity) {
  const sourceOfTruthPath = normalizeFileReference(
    entity?.sourceOfTruthPath ?? entity?.path ?? "",
  );

  return (entity?.mergedPaths ?? [])
    .map((value) => normalizeFileReference(value))
    .filter((value) => value && value !== sourceOfTruthPath);
}

export function normalizeInsight(insight) {
  if (!insight) {
    return null;
  }
  const functionFindings = (insight.functionFindings ?? [])
    .map(normalizeFunctionFinding)
    .filter(Boolean);
  return {
    ...insight,
    moduleBoundary: insight.moduleBoundary,
    interfaceSummary: insight.interfaceSummary,
    branchChange: insight.branchChange,
    callerImpact: insight.callerImpact,
    extensibilitySummary: insight.extensibilitySummary,
    suggestedDirection:
      insight.suggestedDirection || functionFindings[0]?.better || "",
    interfaceTags: insight.interfaceTags ?? [],
    functionFindings,
  };
}

function compactSuggestion(value, maxLength = 72) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function getNodeSuggestionHint(issues = []) {
  const candidate = issues.find((issue) => issue.better || issue.detail);
  return compactSuggestion(candidate?.better || candidate?.detail || "", 54);
}

export function parseCodeLocation(location, worktreePath = "") {
  const text = String(location ?? "").trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^(.*?):(\d+)(?::(\d+))?$/u);
  const filePath = (match?.[1] ?? text).trim();
  const line = Number(match?.[2] ?? 1);
  const column = Number(match?.[3] ?? 1);
  const absolutePath = filePath.startsWith("/")
    ? filePath
    : `${String(worktreePath ?? "").replace(/\/$/u, "")}/${filePath}`;
  return {
    filePath,
    line,
    column,
    absolutePath,
    label: `${filePath}:${line}`,
    cursorUrl: `cursor://file/${encodeURI(absolutePath)}:${line}:${column}`,
  };
}

function getLogicalPath(pathValue, allPaths = new Set()) {
  const normalizedValue = normalizeFileReference(pathValue);
  if (normalizedValue.endsWith(".js")) {
    const tsPath = normalizedValue.replace(/\.js$/u, ".ts");
    if (allPaths.has(tsPath)) {
      return tsPath;
    }
  }
  return normalizedValue;
}

function buildResolver(fileInsights) {
  const basenameToPaths = Object.values(fileInsights).reduce((acc, insight) => {
    if (!acc[insight.basename]) {
      acc[insight.basename] = [];
    }
    acc[insight.basename].push(insight.path);
    return acc;
  }, {});

  return (rawValue) => {
    const normalizedValue = normalizeFileReference(rawValue);
    if (!normalizedValue) {
      return null;
    }

    if (fileInsights[normalizedValue]) {
      return fileInsights[normalizedValue];
    }

    if (basenameToPaths[normalizedValue]?.length === 1) {
      return fileInsights[basenameToPaths[normalizedValue][0]];
    }

    return null;
  };
}

export function buildNormalizedPayloadArtifacts({
  fileInsights,
  changedInterfaces,
  graphDocument,
}) {
  const allLogicalPaths = buildLogicalPathSet({
    fileInsights,
    changedInterfaces,
    graphDocument,
  });
  const normalizedFileInsights = normalizeFileInsightsIndex(
    fileInsights,
    allLogicalPaths,
  );
  const normalizedChangedInterfaces = normalizeChangedInterfaces(
    changedInterfaces,
    allLogicalPaths,
  );
  const normalizePath = (pathValue) => getLogicalPath(pathValue, allLogicalPaths);

  return {
    fileInsights: normalizedFileInsights,
    changedInterfaces: normalizedChangedInterfaces,
    normalizePath,
    resolveFileInsight: buildResolver(normalizedFileInsights),
  };
}
