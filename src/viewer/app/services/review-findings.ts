// @ts-nocheck
import { mapInterfaceFindingSeverity, normalizeInsight } from "./payload";

export function formatFindingLabel(value) {
  return String(value ?? "")
    .replaceAll(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getFindingSeverity(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (
    ["repo-critical", "workflow-critical", "runtime-entrypoint"].includes(
      normalized,
    )
  ) {
    return "risk";
  }
  if (
    ["high-churn", "multi-author", "actively-changing"].includes(normalized)
  ) {
    return "warning";
  }
  return "info";
}

function getSeverityRank(value) {
  return value === "risk" ? 3 : value === "warning" ? 2 : 1;
}

export function getFindingIcon(value) {
  return value === "risk" ? "⚠" : value === "warning" ? "▣" : "◌";
}

function getFindingCategory(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (
    normalized.includes("runtime") ||
    normalized.includes("entrypoint") ||
    normalized.includes("esm") ||
    normalized.includes("install")
  ) {
    return "runtime";
  }
  if (normalized.includes("typecheck") || normalized.includes("compiler")) {
    return "typecheck";
  }
  if (
    normalized.includes("lockfile") ||
    normalized.includes("dependency") ||
    normalized.includes("version")
  ) {
    return "dependencies";
  }
  if (normalized.includes("path") || normalized.includes("portability")) {
    return "portability";
  }
  if (
    normalized.includes("mirror") ||
    normalized.includes("drift") ||
    normalized.includes("generated") ||
    normalized.includes("git hygiene")
  ) {
    return "process";
  }
  return "risk";
}

export function getFindingCategoryLabel(value) {
  return value === "typecheck"
    ? "Typecheck"
    : String(value ?? "risk").replace(/\b\w/g, (match) => match.toUpperCase());
}

export function summarizeIssues(issues = []) {
  const summary = {
    total: issues.length,
    risk: 0,
    warning: 0,
    info: 0,
    primarySeverity: null,
    primaryCount: 0,
    primaryIssue: null,
  };

  for (const issue of issues) {
    if (issue.severity === "risk") summary.risk += 1;
    else if (issue.severity === "warning") summary.warning += 1;
    else summary.info += 1;

    if (
      !summary.primaryIssue ||
      getSeverityRank(issue.severity) > getSeverityRank(summary.primaryIssue.severity)
    ) {
      summary.primaryIssue = issue;
      summary.primarySeverity = issue.severity;
    }
  }

  summary.primaryCount = summary[summary.primarySeverity ?? "info"] ?? 0;
  return summary;
}

export function getIssueMarkerLabel(summary) {
  if (!summary?.primarySeverity) {
    return "";
  }

  return `${getFindingIcon(summary.primarySeverity)} ${summary.primaryCount}`;
}

export function getIssueMarkerTitle(summary) {
  if (!summary) {
    return "";
  }

  return [
    summary.risk ? `${summary.risk} risks` : null,
    summary.warning ? `${summary.warning} warnings` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildStructuredInterfaceFindingsFromInsight({ insight }) {
  const normalizedInsight = normalizeInsight(insight);
  if (!normalizedInsight) {
    return [];
  }

  const findings = [];
  for (const finding of normalizedInsight.functionFindings ?? []) {
    findings.push({
      id: `${normalizedInsight.path}:function:${finding.functionName}:${finding.location}`,
      category: "interface",
      severity: mapInterfaceFindingSeverity(finding.priority),
      title: finding.functionName,
      detail: finding.problem,
      path: normalizedInsight.path,
      functionName: finding.functionName,
      location: finding.location,
      before: finding.before,
      current: finding.current,
      simplificationStrategy: finding.simplificationStrategy,
      combineWith: finding.combineWith,
      better: finding.better,
      whyBetter: finding.whyBetter,
      consumerImpact: finding.consumerImpact,
      migrationNotes: finding.migrationNotes,
      whyConfusing: finding.whyConfusing,
      fixPrompt: finding.fixPrompt,
      codePreview: `${finding.before}\n→\n${finding.current}\n⇒\n${finding.better}`,
    });
  }

  return findings;
}

export function buildFallbackHeuristicFindingsFromInsight({
  insight,
  nodeLabel,
}) {
  const normalizedInsight = normalizeInsight(insight);
  if (!normalizedInsight) {
    return [];
  }

  const findings = [];

  for (const signal of normalizedInsight.interfaceTags ?? []) {
    findings.push({
      id: `${normalizedInsight.path}:risk:${signal}`,
      category: getFindingCategory(signal),
      severity: getFindingSeverity(signal),
      title: formatFindingLabel(signal),
      detail:
        normalizedInsight.extensibilitySummary ||
        normalizedInsight.branchChange ||
        `Review ${nodeLabel} closely.`,
      path: normalizedInsight.path,
    });
  }

  for (const reason of normalizedInsight.impactReasons ?? []) {
    findings.push({
      id: `${normalizedInsight.path}:impact:${reason}`,
      category: "impact",
      severity: "warning",
      title: "Impact path changed",
      detail: reason,
      path: normalizedInsight.path,
    });
  }

  return findings;
}

export function buildFindingsFromInsight({ insight, nodeLabel }) {
  return {
    structuredInterfaceFindings: buildStructuredInterfaceFindingsFromInsight({
      insight,
    }),
    fallbackHeuristicFindings: buildFallbackHeuristicFindingsFromInsight({
      insight,
      nodeLabel,
    }),
  };
}

export function getInterfaceSuggestion(finding) {
  if (!finding) {
    return "No concrete interface improvement was generated.";
  }

  if (finding.better) {
    return finding.better;
  }

  return (
    finding.detail ||
    finding.problem ||
    "No concrete interface improvement was generated."
  );
}

export function getPromptPreview(prompt) {
  const lines = String(prompt ?? "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return lines.join("\n");
}

export function getCodePreviewSnippet(code) {
  return String(code ?? "")
    .trim()
    .split("\n")
    .slice(0, 8)
    .join("\n");
}
