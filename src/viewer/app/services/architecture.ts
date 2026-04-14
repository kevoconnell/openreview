// @ts-nocheck
import { normalizeFileReference, normalizeInsight } from "./payload";

const REPO_PART_DEFINITIONS = [
  {
    id: "part:shell-auto-enable",
    label: "Shell auto-enable",
    role: "entrypoint",
    description:
      "Shell hooks that decide when OpenReview and bootstrap logic start.",
  },
  {
    id: "part:launchers",
    label: "Launchers",
    role: "entrypoint",
    description:
      "CLI entrypoints that wire cmux, env injection, and workspace startup.",
  },
  {
    id: "part:tmux-shim",
    label: "tmux shim",
    role: "adapter",
    description:
      "Compatibility layer between cmux state and tmux-shaped expectations.",
  },
  {
    id: "part:workspace-state",
    label: "Workspace state contract",
    role: "interface",
    description:
      "The persistence contract shared by launcher, viewer, shim, and service code.",
  },
  {
    id: "part:shared-kernel",
    label: "Shared kernel",
    role: "boundary",
    description: "Low-level runtime helpers reused by the rest of the repo.",
  },
  {
    id: "part:openreview-pipeline",
    label: "OpenReview pipeline",
    role: "boundary",
    description:
      "The review generator, analysis pipeline, and viewer build path.",
  },
  {
    id: "part:viewer-contract",
    label: "Viewer contract",
    role: "interface",
    description:
      "The payload, graph, and UI contract that turns analysis into a readable review.",
  },
  {
    id: "part:opencode-server",
    label: "OpenCode server",
    role: "adapter",
    description:
      "The shared backend that serves OpenCode sessions for the workspace and review flows.",
  },
  {
    id: "part:runtime-shadow",
    label: "Runtime shadow",
    role: "artifact",
    description:
      "Generated runtime files, local config, and viewer outputs that must stay coherent.",
  },
];

export const REPO_PART_POSITIONS = {
  "part:shell-auto-enable": { x: 60, y: 44 },
  "part:launchers": { x: 370, y: 44 },
  "part:opencode-server": { x: 690, y: 44 },
  "part:tmux-shim": { x: 60, y: 254 },
  "part:workspace-state": { x: 370, y: 254 },
  "part:shared-kernel": { x: 690, y: 254 },
  "part:openreview-pipeline": { x: 1000, y: 254 },
  "part:runtime-shadow": { x: 370, y: 464 },
  "part:viewer-contract": { x: 690, y: 464 },
};

export const REPO_PARTS_BY_ID = Object.fromEntries(
  REPO_PART_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const REPO_PART_IDS_BY_LABEL = Object.fromEntries(
  REPO_PART_DEFINITIONS.map((definition) => [
    definition.label.toLowerCase(),
    definition.id,
  ]),
);

export function summarizeArchitectureIssues(issues = []) {
  return {
    boundary: issues.filter((issue) => issue.category === "impact").length,
    interfaces: issues.filter(
      (issue) =>
        issue.category === "interface" ||
        issue.category === "typecheck" ||
        issue.category === "dependencies",
    ).length,
    contracts: issues.filter(
      (issue) =>
        issue.category === "runtime" ||
        issue.category === "risk" ||
        issue.category === "portability",
    ).length,
  };
}

export function getRepoPartIdsForPath(pathValue) {
  const normalizedValue = normalizeFileReference(pathValue).replace(/\/$/u, "");
  if (!normalizedValue) {
    return [];
  }

  const partIds = [];

  if (/^shell\//u.test(normalizedValue)) partIds.push("part:shell-auto-enable");
  if (
    /^(bin\/opencmux-tmux-shim\.[jt]s|runtime\/bin\/tmux)$/u.test(
      normalizedValue,
    )
  )
    partIds.push("part:tmux-shim");
  if (
    /^bin\//u.test(normalizedValue) ||
    /^src\/worktree\.[jt]s$/u.test(normalizedValue)
  )
    partIds.push("part:launchers");
  if (
    /^src\/shared\.[jt]s$/u.test(normalizedValue) ||
    /^runtime\/state\//u.test(normalizedValue)
  )
    partIds.push("part:workspace-state");
  if (/^(src\/shared\.[jt]s|src\/json\.[jt]s)$/u.test(normalizedValue))
    partIds.push("part:shared-kernel");
  if (
    /^(src\/openreview\.[jt]s|src\/file-insights\.[jt]s|runtime\/bin\/openreview(?:-generate)?)$/u.test(
      normalizedValue,
    )
  )
    partIds.push("part:openreview-pipeline");
  if (/^(src\/viewer\/|runtime\/viewer\/)/u.test(normalizedValue))
    partIds.push("part:viewer-contract");
  if (
    /^(src\/opencode-server\.[jt]s|bin\/opencmux-opencode-server\.[jt]s)$/u.test(
      normalizedValue,
    )
  )
    partIds.push("part:opencode-server");
  if (
    /^(runtime\/config\/|runtime\/state\/|runtime\/viewer\/|\.openreview\/|package\.json|tsconfig\.json)$/u.test(
      normalizedValue,
    )
  )
    partIds.push("part:runtime-shadow");

  return [...new Set(partIds)];
}

export function getPrimaryRepoPartIdForPath(pathValue) {
  return getRepoPartIdsForPath(pathValue)[0] ?? null;
}

export function getArchitectureRole(node, insight) {
  if (!node) {
    return "internal";
  }

  if (node.role) {
    return node.role;
  }

  if (node.type === "group") {
    return "boundary";
  }

  const pathValue = String(
    insight?.path ?? node.path ?? node.label ?? "",
  ).toLowerCase();
  const fileName = pathValue.split("/").pop() ?? pathValue;

  if (
    pathValue.startsWith("runtime/") ||
    pathValue.startsWith(".openreview/")
  ) {
    return "artifact";
  }
  if (
    pathValue.startsWith("bin/") ||
    /(^|\/)(main|cli|index|launch|launcher)(\.|$)/.test(fileName)
  ) {
    return "entrypoint";
  }
  if (
    /(adapter|bridge|shim|gateway|client|server|transport|mcp|wrapper)/.test(
      pathValue,
    )
  ) {
    return "adapter";
  }
  if (/(interface|contract|schema|types|props|api|public)/.test(pathValue)) {
    return "interface";
  }

  return "internal";
}

function isConsumerFacingRole(role) {
  return role === "entrypoint" || role === "interface" || role === "adapter";
}

export function getNodeDisplayHint({ node, insight, issues, groupContext = "" }) {
  if (node.summary) {
    return node.summary;
  }

  if (node.type === "group") {
    return groupContext;
  }

  const role = getArchitectureRole(node, insight);
  const hasRisk = issues.some((issue) => issue.severity === "risk");
  const hasWarning = issues.some((issue) => issue.severity === "warning");
  const hasBoundaryDrift = issues.some((issue) => issue.category === "impact");

  if (isConsumerFacingRole(role) && hasRisk) return "bad interface";
  if (hasBoundaryDrift) return "boundary leak";
  if (isConsumerFacingRole(role) && hasWarning) return "needs cleanup";
  if (role === "entrypoint") return "consumer surface";
  if (role === "interface") return "interface surface";
  if (role === "adapter") return "integration seam";
  return "";
}

export function getArchitectureRoleEdgeLabel(edge, sourceNode, targetNode) {
  if (edge.label) {
    return edge.label;
  }

  if (edge.type === "impact") {
    return edge.reasons?.[0] ? edge.reasons[0].slice(0, 28) : "boundary drift";
  }

  const sourceRole = getArchitectureRole(sourceNode, null);
  const targetRole = getArchitectureRole(targetNode, null);
  if (sourceRole === "entrypoint" && targetRole !== "entrypoint")
    return "orchestrates";
  if (sourceRole === "adapter" || targetRole === "adapter") return "adapts";
  if (sourceRole === "interface" || targetRole === "interface")
    return "defines contract";
  if (sourceRole === "boundary" || targetRole === "boundary") return "contains";
  return "depends on";
}

export function getNodeVisualState(node, insight) {
  const normalizedInsight = normalizeInsight(insight);
  const isChanged = node.state === "changed";
  const isAffected = node.state === "affected";
  const isRisky = Boolean(
    (normalizedInsight?.interfaceTags ?? []).length ||
      (normalizedInsight?.impactReasons ?? []).length ||
      (normalizedInsight?.functionFindings ?? []).length,
  );
  const role = getArchitectureRole(node, insight);
  const tone = isChanged
    ? "changed"
    : isAffected
      ? "affected"
      : isRisky
        ? "risky"
        : "context";
  return {
    isChanged,
    isAffected,
    isRisky,
    role,
    tone,
    className: [
      "graph-node",
      node.type === "group" ? "graph-node-group" : "",
      `graph-node-role-${role}`,
      isChanged ? "graph-node-changed" : "",
      !isChanged && isAffected ? "graph-node-affected" : "",
      !isChanged && !isAffected && isRisky ? "graph-node-risky" : "",
      !isChanged && !isAffected && !isRisky && node.type === "file"
        ? "graph-node-safe"
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export function getNodeMeta(node, insight, groupContext = "") {
  if (node.type === "group") {
    return groupContext;
  }

  if (normalizeInsight(insight)?.moduleBoundary) {
    return normalizeInsight(insight).moduleBoundary;
  }

  const pathValue = insight?.path ?? node.path ?? "";
  const segments = String(pathValue).split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "repo file";
  }

  return segments.slice(0, -1).join("/");
}

export function resolveCompareBranches({
  reviewDiff,
  currentBranch,
  fetchedBranches = [],
}) {
  const allOptions = [
    ...fetchedBranches,
    ...(Array.isArray(reviewDiff?.compareOptions)
      ? reviewDiff.compareOptions
      : []),
    ...Object.keys(reviewDiff?.comparisons ?? {}),
    reviewDiff?.baseLabel,
  ]
    .map((option) => String(option ?? "").trim())
    .filter(
      (option, index, allOptions) =>
        option && allOptions.indexOf(option) === index,
    );

  const filteredOptions = allOptions.filter(
    (option) => option !== currentBranch,
  );

  const preferredDefaults = ["main", "origin/main"];
  const sortedOptions = filteredOptions.sort((left, right) => {
    const leftPriority = preferredDefaults.indexOf(left);
    const rightPriority = preferredDefaults.indexOf(right);
    if (leftPriority !== -1 || rightPriority !== -1) {
      if (leftPriority === -1) return 1;
      if (rightPriority === -1) return -1;
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });

  const options = sortedOptions.length || !currentBranch ? sortedOptions : [currentBranch];
  const fallbackBranch = String(reviewDiff?.baseLabel ?? "").trim();
  const preferred = options.includes("main")
    ? "main"
    : fallbackBranch && options.includes(fallbackBranch)
      ? fallbackBranch
      : (options[0] ?? "");

  return {
    options,
    preferred,
  };
}
