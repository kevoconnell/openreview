// @ts-nocheck
import { Component, createElement, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { marked } from "marked";
import mermaid from "mermaid";

const html = htm.bind(createElement);

const payloadElement = document.getElementById("viewer-data");
const payload = payloadElement?.textContent
  ? JSON.parse(payloadElement.textContent)
  : {};
const viewerControlPort = payload?.sessionDebug?.viewer?.controlPort ?? null;
const viewerControlToken = payload?.sessionDebug?.viewer?.controlToken ?? null;
let mermaidInitialized = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function canHardResetViewer() {
  return typeof viewerControlPort === "number" && viewerControlPort > 0;
}

async function requestViewerHardReset() {
  if (!canHardResetViewer()) {
    throw new Error(
      "Hard reset is unavailable until the viewer control server is running.",
    );
  }

  let resolvedControlToken =
    typeof viewerControlToken === "string" && viewerControlToken
      ? viewerControlToken
      : null;

  if (!resolvedControlToken) {
    try {
      const statusResponse = await fetch(
        `http://127.0.0.1:${viewerControlPort}/control/status`,
      );
      if (statusResponse.ok) {
        const statusBody = await statusResponse.json();
        const nextToken = statusBody?.sessionDebug?.viewer?.controlToken;
        if (typeof nextToken === "string" && nextToken) {
          resolvedControlToken = nextToken;
        }
      }
    } catch {
      // Ignore token refresh failures and fall through to the reset request.
    }
  }

  const response = await fetch(
    `http://127.0.0.1:${viewerControlPort}/control/hard-reset`,
    {
      method: "POST",
      headers:
        typeof resolvedControlToken === "string" && resolvedControlToken
          ? { "X-OpenReview-Control-Token": resolvedControlToken }
          : {},
    },
  );

  if (!response.ok) {
    let errorMessage = `Hard reset failed with status ${response.status}.`;
    try {
      const responseBody = await response.json();
      if (
        responseBody &&
        typeof responseBody.error === "string" &&
        responseBody.error.trim()
      ) {
        errorMessage = responseBody.error;
      }
    } catch {
      // Ignore malformed error bodies.
    }
    throw new Error(errorMessage);
  }
}

function HardResetActions() {
  const [resetState, setResetState] = useState("idle");
  const [resetMessage, setResetMessage] = useState(
    canHardResetViewer()
      ? ""
      : "Hard reset is unavailable until the viewer control server is running.",
  );

  const handleHardReset = async () => {
    if (!canHardResetViewer() || resetState === "running") {
      return;
    }

    setResetState("running");
    setResetMessage("Hard resetting the viewer and rebuilding artifacts…");

    try {
      await requestViewerHardReset();
      setResetState("done");
      setResetMessage("Hard reset complete. Reloading…");
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      setResetState("error");
      setResetMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return html`<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
    <button
      className="git-review-action git-review-action-primary"
      onClick=${handleHardReset}
      disabled=${resetState === "running" || !canHardResetViewer()}
    >
      ${resetState === "running" ? "Hard resetting…" : "Hard reset viewer"}
    </button>
    <button className="git-review-action" onClick=${() => window.location.reload()}>
      Reload
    </button>
    ${resetMessage
      ? html`<p className="inspector-copy inspector-copy-secondary" style=${{ margin: 0, flexBasis: "100%" }}>
          ${resetMessage}
        </p>`
      : null}
  </div>`;
}

function renderFatalViewerError(error) {
  const rootElement = document.getElementById("viewer-root");
  if (!rootElement) {
    return;
  }

  rootElement.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:32px;background:linear-gradient(180deg,#0a0f1b 0%, #0b1020 100%);color:#e7ecf5;font-family:Inter,ui-sans-serif,system-ui,sans-serif;"><div style="max-width:720px;width:100%;border:1px solid rgba(255,255,255,0.08);border-radius:18px;background:rgba(16,24,43,0.92);padding:24px;box-shadow:0 24px 60px rgba(2,6,23,0.45);"><p style="margin:0 0 8px;color:#9fb2ca;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">OpenReview viewer failed</p><h1 style="margin:0 0 10px;font-size:20px;">The viewer hit a runtime error</h1><p id="openreview-fatal-error-message" style="margin:0;color:#cbd5e1;line-height:1.6;white-space:pre-wrap;"></p><div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;"><button id="openreview-fatal-hard-reset" style="appearance:none;border:0;border-radius:10px;padding:11px 14px;background:#2563eb;color:#eff6ff;font-weight:600;cursor:pointer;">Hard reset viewer</button><button id="openreview-fatal-reload" style="appearance:none;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:11px 14px;background:rgba(15,23,42,0.92);color:#cbd5e1;font-weight:600;cursor:pointer;">Reload</button></div><p id="openreview-fatal-status" style="margin:14px 0 0;color:#94a3b8;line-height:1.5;"></p></div></div>`;

  const messageElement = document.getElementById("openreview-fatal-error-message");
  const hardResetButton = document.getElementById("openreview-fatal-hard-reset");
  const reloadButton = document.getElementById("openreview-fatal-reload");
  const statusElement = document.getElementById("openreview-fatal-status");

  if (messageElement) {
    messageElement.textContent = String(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
  }

  const setStatus = (value) => {
    if (statusElement) {
      statusElement.textContent = value;
    }
  };

  if (!canHardResetViewer() && hardResetButton) {
    hardResetButton.setAttribute("disabled", "true");
    hardResetButton.style.opacity = "0.6";
    hardResetButton.style.cursor = "not-allowed";
    setStatus("Hard reset is unavailable until the viewer control server is running.");
  }

  reloadButton?.addEventListener("click", () => window.location.reload());
  hardResetButton?.addEventListener("click", async () => {
    if (!canHardResetViewer()) {
      return;
    }
    hardResetButton.setAttribute("disabled", "true");
    hardResetButton.style.opacity = "0.6";
    hardResetButton.style.cursor = "progress";
    setStatus("Hard resetting the viewer and rebuilding artifacts…");
    try {
      await requestViewerHardReset();
      setStatus("Hard reset complete. Reloading…");
      window.setTimeout(() => window.location.reload(), 300);
    } catch (requestError) {
      hardResetButton.removeAttribute("disabled");
      hardResetButton.style.opacity = "1";
      hardResetButton.style.cursor = "pointer";
      setStatus(
        requestError instanceof Error
          ? requestError.message
          : String(requestError),
      );
    }
  });
}

class ViewerErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return html`<div className="status-shell">
        <div className="status-shell-card">
          <p className="status-shell-kicker">OpenReview viewer failed</p>
          <h1 className="status-shell-title">The viewer hit a runtime error</h1>
          <p className="status-shell-copy">
            ${String(this.state.error?.message ?? this.state.error)}
          </p>
          <${HardResetActions} />
        </div>
      </div>`;
    }

    return this.props.children;
  }
}

const cssEscape = (value) => {
  if (window.CSS?.escape) {
    return window.CSS.escape(String(value));
  }

  return String(value).replaceAll('"', '\\"');
};

const normalizeFileReference = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^\.\//u, "")
    .replace(/[)\],:;]+$/gu, "")
    .replace(/^file:\/\//u, "");

const STATUS_PHASES = [
  {
    key: "launch",
    label: "Launch",
    description: "Preparing the workspace viewer",
  },
  {
    key: "scan",
    label: "Scan",
    description: "Collecting repo and change context",
  },
  { key: "docs", label: "Docs", description: "Writing docs and file insights" },
  { key: "view", label: "View", description: "Refreshing the browser surface" },
];

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

const REPO_PART_POSITIONS = {
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

const REPO_PART_EDGE_DEFINITIONS = [
  {
    id: "edge:shell-launchers",
    source: "part:shell-auto-enable",
    target: "part:launchers",
    label: "execs bootstrap",
  },
  {
    id: "edge:launchers-tmux",
    source: "part:launchers",
    target: "part:tmux-shim",
    label: "injects tmux shim",
  },
  {
    id: "edge:launchers-state",
    source: "part:launchers",
    target: "part:workspace-state",
    label: "writes workspace state",
  },
  {
    id: "edge:tmux-state",
    source: "part:tmux-shim",
    target: "part:workspace-state",
    label: "reads state contract",
  },
  {
    id: "edge:launchers-shared",
    source: "part:launchers",
    target: "part:shared-kernel",
    label: "imports shared helpers",
  },
  {
    id: "edge:shared-state",
    source: "part:shared-kernel",
    target: "part:workspace-state",
    label: "defines schema + persistence",
  },
  {
    id: "edge:launchers-review",
    source: "part:launchers",
    target: "part:openreview-pipeline",
    label: "starts review pipeline",
  },
  {
    id: "edge:launchers-opencode",
    source: "part:launchers",
    target: "part:opencode-server",
    label: "shares OpenCode backend",
  },
  {
    id: "edge:shared-runtime",
    source: "part:shared-kernel",
    target: "part:runtime-shadow",
    label: "materializes runtime layout",
  },
  {
    id: "edge:review-viewer",
    source: "part:openreview-pipeline",
    target: "part:viewer-contract",
    label: "builds viewer payload",
  },
  {
    id: "edge:viewer-runtime",
    source: "part:viewer-contract",
    target: "part:runtime-shadow",
    label: "writes viewer output",
  },
  {
    id: "edge:opencode-runtime",
    source: "part:opencode-server",
    target: "part:runtime-shadow",
    label: "uses runtime config",
  },
];

const REPO_PARTS_BY_ID = Object.fromEntries(
  REPO_PART_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const REPO_PART_IDS_BY_LABEL = Object.fromEntries(
  REPO_PART_DEFINITIONS.map((definition) => [
    definition.label.toLowerCase(),
    definition.id,
  ]),
);
const REPO_PART_METHODS_BY_ID = {
  "part:shell-auto-enable": ["detectWorkspace()", "bootOpenReview()"],
  "part:launchers": [
    "launchWorkspace()",
    "startReviewService()",
    "shareOpenCodeBackend()",
  ],
  "part:tmux-shim": ["readWorkspaceState()", "bridgeTmuxCalls()"],
  "part:workspace-state": ["readSurfaceShimState()", "writeSurfaceShimState()"],
  "part:shared-kernel": [
    "ensureRuntimeArtifacts()",
    "ensureBrowserPaneForWorkspace()",
  ],
  "part:openreview-pipeline": [
    "runOpenReview()",
    "buildViewerSiteFromOpenReview()",
  ],
  "part:viewer-contract": ["buildOverviewGraphHtml()", "renderViewerPayload()"],
  "part:opencode-server": [
    "ensureGlobalOpenCodeServer()",
    "disposeOpenCodeInstance()",
  ],
  "part:runtime-shadow": ["materializeRuntimeState()", "writeViewerOutput()"],
};

const INSPECTOR_WIDTH_KEY = "openreview:inspector-width:v2";
const DEFAULT_INSPECTOR_WIDTH = 360;
const MIN_INSPECTOR_WIDTH = 280;
const MAX_INSPECTOR_WIDTH = 760;
const LEFT_PANEL_WIDTH_KEY = "openreview:left-panel-width:v2";
const DEFAULT_LEFT_PANEL_WIDTH = 260;
const MIN_LEFT_PANEL_WIDTH = 96;
const MAX_LEFT_PANEL_WIDTH = 420;
const IS_MAC_PLATFORM = /Mac|iPhone|iPad|iPod/u.test(
  navigator.platform || navigator.userAgent || "",
);
function getStatusPhaseIndex(phase) {
  const index = STATUS_PHASES.findIndex((entry) => entry.key === phase);
  return index === -1 ? 0 : index;
}

function formatDebugValue(value) {
  if (value === null || typeof value === "undefined") {
    return "—";
  }

  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "[]";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function summarizeArchitectureIssues(issues = []) {
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

function mapInterfaceFindingSeverity(value) {
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

function isCombineOpportunity(finding) {
  return (
    finding?.simplificationStrategy === "combine" ||
    (Array.isArray(finding?.combineWith) && finding.combineWith.length > 0)
  );
}

function getSimplificationStrategyLabel(value) {
  return value ? formatFindingLabel(value) : "Stabilize";
}

function dedupeBy(items, getKey) {
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

function getCollapsedAliasPaths(entity) {
  const sourceOfTruthPath = normalizeFileReference(
    entity?.sourceOfTruthPath ?? entity?.path ?? "",
  );

  return (entity?.mergedPaths ?? [])
    .map((value) => normalizeFileReference(value))
    .filter((value) => value && value !== sourceOfTruthPath);
}

function renderSourceOfTruthMeta(entity) {
  const sourceOfTruthPath = entity?.sourceOfTruthPath ?? entity?.path;
  const aliasPaths = getCollapsedAliasPaths(entity);

  if (!sourceOfTruthPath || !aliasPaths.length) {
    return null;
  }

  return html`
    <div className="inspector-section">
      <p className="inspector-kicker">Source of truth</p>
      <div className="inspector-pill-grid">
        <span className="inspector-pill">${sourceOfTruthPath}</span>
      </div>
      <p className="inspector-copy inspector-copy-secondary">
        This viewer collapses duplicate generated/runtime surfaces into one
        logical interface.
      </p>
      <div className="inspector-pill-grid">
        ${aliasPaths.map(
          (aliasPath) =>
            html`<span key=${aliasPath} className="inspector-pill"
              >Collapsed: ${aliasPath}</span
            >`,
        )}
      </div>
    </div>
  `;
}

function normalizeInsight(insight) {
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

function getNodeSuggestionHint(issues = []) {
  const candidate = issues.find((issue) => issue.better || issue.detail);
  return compactSuggestion(candidate?.better || candidate?.detail || "", 54);
}

function parseCodeLocation(location, worktreePath = "") {
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

function getRepoPartIdsForPath(pathValue) {
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
  if (
    /^(src\/viewer-app\.js|src\/viewer-overrides\.css|runtime\/viewer\/)/u.test(
      normalizedValue,
    )
  )
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

function getPrimaryRepoPartIdForPath(pathValue) {
  return getRepoPartIdsForPath(pathValue)[0] ?? null;
}

function getArchitectureRole(node, insight) {
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

function getArchitectureRoleLabel(role) {
  return role === "entrypoint"
    ? "Entrypoint"
    : role === "adapter"
      ? "Adapter"
      : role === "boundary"
        ? "Boundary"
        : role === "artifact"
          ? "Artifact"
          : role === "interface"
            ? "Interface"
            : "Internal";
}

function getArchitectureRolePriority(role) {
  return role === "entrypoint"
    ? 0
    : role === "interface"
      ? 1
      : role === "adapter"
        ? 2
        : role === "boundary"
          ? 3
          : role === "internal"
            ? 4
            : 5;
}

function isConsumerFacingRole(role) {
  return role === "entrypoint" || role === "interface" || role === "adapter";
}

function getNodeDisplayHint({ node, insight, issues, groupContext = "" }) {
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

function getArchitectureRoleEdgeLabel(edge, sourceNode, targetNode) {
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

function getScorecardTone(count) {
  return count === 0 ? "healthy" : count === 1 ? "watch" : "risk";
}

function ArchitectureScorecard({ reviewIssues }) {
  const summary = summarizeArchitectureIssues(reviewIssues);
  const items = [
    { key: "boundary", label: "Boundary clarity", count: summary.boundary },
    {
      key: "interfaces",
      label: "Interface narrowness",
      count: summary.interfaces,
    },
    {
      key: "contracts",
      label: "Contract explicitness",
      count: summary.contracts,
    },
  ];

  return html`
    <section className="architecture-scorecard">
      <div className="architecture-scorecard-head">
        <p className="inspector-kicker">Interface quality</p>
        <span className="inspector-list-meta">Review scorecard</span>
      </div>
      <div className="architecture-scorecard-grid">
        ${items.map(
          (item) => html`
            <div
              key=${item.key}
              className=${`architecture-scorecard-item architecture-scorecard-item-${getScorecardTone(item.count)}`}
            >
              <span className="architecture-scorecard-label"
                >${item.label}</span
              >
              <strong className="architecture-scorecard-value"
                >${item.count === 0
                  ? "Healthy"
                  : item.count === 1
                    ? "Watch"
                    : "Risk"}</strong
              >
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function getViewerDebugMetrics(payload) {
  const reviewDiff = payload.reviewDiff ?? null;
  const reviewIssues = payload.reviewIssues ?? [];
  const graphDocument = payload.graphDocument ?? null;

  return [
    { label: "Compare base", value: reviewDiff?.baseLabel ?? "—" },
    { label: "Changed files", value: reviewDiff?.files?.length ?? 0 },
    { label: "Issue count", value: reviewIssues.length },
    { label: "Graph nodes", value: graphDocument?.nodes?.length ?? 0 },
  ];
}

function getOpenCodeModelLabel(reviewDebug) {
  const model = reviewDebug?.openCode?.model ?? null;
  return model?.providerID && model?.modelID
    ? `${model.providerID}/${model.modelID}`
    : formatDebugValue(model);
}

function summarizeOpenCodePart(part) {
  if (!part || typeof part !== "object") {
    return null;
  }

  const compact = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();

  switch (part.type) {
    case "text":
    case "reasoning": {
      const text = String(part.text ?? "").trim();
      return text || null;
    }
    case "tool": {
      const title = compact(part.title);
      const tool = compact(part.tool);
      const state = compact(part.state);
      const output = String(part.output ?? "").trim();
      const error = String(part.error ?? "").trim();
      const body = error || output;
      return [tool || "tool", title || state, body]
        .filter(Boolean)
        .join(body ? "\n" : " · ");
    }
    case "step-start":
      return "Started a new review step.";
    case "step-finish":
      return compact(part.reason)
        ? `Finished step · ${compact(part.reason)}`
        : "Finished step.";
    case "subtask":
      return [
        compact(part.agent),
        compact(part.description),
        compact(part.prompt),
      ]
        .filter(Boolean)
        .join(" · ");
    case "agent":
      return compact(part.name)
        ? `Using agent ${compact(part.name)}`
        : "Using an agent.";
    case "retry":
      return compact(part.attempt)
        ? `Retry ${compact(part.attempt)}`
        : "Retrying.";
    case "file":
      return compact(part.filename) || compact(part.url) || "Attached a file.";
    default:
      return null;
  }
}

function getOpenCodeLiveEntries(reviewDebug, limit = null) {
  const messages = reviewDebug?.openCode?.messages ?? [];
  const entries = [];

  messages.forEach((message, messageIndex) => {
    (message.parts ?? []).forEach((part, partIndex) => {
      const summary = summarizeOpenCodePart(part);
      if (!summary) {
        return;
      }

      entries.push({
        id: `${message.id ?? messageIndex}:${part.id ?? partIndex}`,
        role: message.role ?? "assistant",
        type: part.type ?? "unknown",
        summary,
        createdAt: message.createdAt ?? part.createdAt ?? null,
      });
    });
  });

  return typeof limit === "number" ? entries.slice(-limit) : entries;
}

function formatRelativeTime(value) {
  if (!value) {
    return "just now";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "just now";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function getPanelWidthMax({ direction }) {
  if (typeof window === "undefined") {
    return direction === "left" ? MAX_LEFT_PANEL_WIDTH : MAX_INSPECTOR_WIDTH;
  }

  const hardMax =
    direction === "left" ? MAX_LEFT_PANEL_WIDTH : MAX_INSPECTOR_WIDTH;
  const viewportRatio = direction === "left" ? 0.4 : 0.7;
  const hardMin =
    direction === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_INSPECTOR_WIDTH;
  return Math.max(
    hardMin,
    Math.min(hardMax, Math.floor(window.innerWidth * viewportRatio)),
  );
}

function clampPanelWidth(width, { direction }) {
  const hardMin =
    direction === "left" ? MIN_LEFT_PANEL_WIDTH : MIN_INSPECTOR_WIDTH;
  return Math.max(hardMin, Math.min(getPanelWidthMax({ direction }), width));
}

function useResizablePanel({ storageKey, defaultWidth, direction }) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(stored)
        ? clampPanelWidth(stored, { direction })
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const dragRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, [storageKey, width]);

  useEffect(() => {
    const updateWidth = (clientX) => {
      if (!dragRef.current || typeof clientX !== "number") {
        return;
      }

      const delta =
        direction === "left"
          ? clientX - dragRef.current.startX
          : dragRef.current.startX - clientX;
      setWidth(
        clampPanelWidth(dragRef.current.startWidth + delta, { direction }),
      );
    };

    const onPointerMove = (event) => {
      updateWidth(event.clientX);
    };

    const onMouseMove = (event) => {
      updateWidth(event.clientX);
    };

    const stopDragging = () => {
      if (!dragRef.current) {
        return;
      }

      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const onResize = () => {
      setWidth((currentWidth) => clampPanelWidth(currentWidth, { direction }));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("resize", onResize);
      stopDragging();
    };
  }, [direction]);

  const startDragging = (clientX) => {
    dragRef.current = { startX: clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    startDragging(event.clientX);
  };

  const onMouseDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    startDragging(event.clientX);
  };

  return {
    shellStyle: {},
    panelStyle: {
      width: `${width}px`,
      minWidth: `${width}px`,
      flex: `0 0 ${width}px`,
    },
    onPointerDown,
    onMouseDown,
  };
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

function StatusSkeletonShell({
  title,
  message,
  worktreePath,
  phase,
  highlights = [],
  reviewDebug,
  sessionDebug,
}) {
  const activePhaseIndex = getStatusPhaseIndex(phase);
  const openCodeSummary = reviewDebug?.openCode ?? null;
  const [, forceTick] = useState(0);
  const liveEntries = getOpenCodeLiveEntries(reviewDebug);
  const sessionId = openCodeSummary?.sessionId ?? "starting…";
  const modelLabel = getOpenCodeModelLabel(reviewDebug);
  const viewerStatus = sessionDebug?.viewer?.status ?? "starting";
  const viewerError = sessionDebug?.viewer?.lastError ?? null;
  const listRef = useRef(null);
  const skeletonNodes = [
    { left: 76, top: 74, size: "small" },
    { left: 312, top: 58, size: "" },
    { left: 552, top: 126, size: "small" },
    { left: 806, top: 88, size: "" },
  ];

  const scrollToLatest = () => {
    const element = listRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      forceTick((value) => value + 1);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return html`
    <div className="status-shell viewer-root">
      <div className="status-shell-topbar">
        <div className="status-shell-brand">
          <div>
            <div className="status-shell-brand-block"></div>
            <div className="status-inline-meta" style=${{ marginTop: "8px" }}>
              ${title}
            </div>
          </div>
        </div>
        <div className="status-shell-toolbar">
          <div className="status-shell-toolbar-pill"></div>
          <div className="status-shell-toolbar-pill"></div>
        </div>
      </div>
      <div className="status-shell-layout">
        <aside className="status-shell-sidebar">
          <div className="status-shell-sidebar-card">
            <p className="inspector-kicker">Live session</p>
            <div className="viewer-debug-chip-row">
              <span className="viewer-debug-chip"
                >Phase:
                ${STATUS_PHASES[activePhaseIndex]?.label ?? "Loading"}</span
              >
              <span className="viewer-debug-chip">Viewer: ${viewerStatus}</span>
              <span className="viewer-debug-chip">Session: ${sessionId}</span>
              <span className="viewer-debug-chip">Model: ${modelLabel}</span>
            </div>
            ${viewerError
              ? html`<p
                  className="status-inline-meta"
                  style=${{ color: "#fca5a5" }}
                >
                  ${viewerError}
                </p>`
              : null}
          </div>
          <div className="status-shell-list-toolbar">
            <p className="status-inline-meta">
              ${liveEntries.length
                ? `${liveEntries.length} events`
                : "Waiting for live events"}
            </p>
            <button
              className="status-shell-list-action"
              onClick=${scrollToLatest}
            >
              Jump to latest
            </button>
          </div>
          <div className="status-shell-list" tabindex="0" ref=${listRef}>
            ${liveEntries.length
              ? liveEntries.map(
                  (entry) =>
                    html`<div
                      key=${entry.id}
                      className="status-shell-list-item"
                    >
                      <div className="status-shell-list-meta">
                        <span
                          className=${`status-shell-list-dot status-shell-list-dot-${entry.type}`}
                        ></span>
                        <span className="viewer-debug-chip">${entry.role}</span>
                        <span
                          className=${`viewer-debug-chip viewer-debug-chip-${entry.type}`}
                          >${entry.type}</span
                        >
                        <span className="status-shell-list-time"
                          >${formatRelativeTime(entry.createdAt)}</span
                        >
                      </div>
                      <div className="status-shell-log-text">
                        ${entry.summary}
                      </div>
                    </div>`,
                )
              : Array.from({ length: 5 }).map(
                  (_, index) =>
                    html`<div key=${index} className="status-shell-list-item">
                      <div
                        className="status-shell-line"
                        style=${{ width: `${72 - index * 6}%` }}
                      ></div>
                      <div
                        className="status-shell-line-short"
                        style=${{ width: `${54 + index * 4}%` }}
                      ></div>
                      <div className="status-shell-list-meta">
                        <span className="status-shell-list-dot"></span>
                        <div className="status-shell-chip"></div>
                        <div
                          className="status-shell-chip"
                          style=${{ width: `${62 + index * 8}px` }}
                        ></div>
                      </div>
                    </div>`,
                )}
          </div>
          <div className="status-shell-sidebar-card">
            <p className="inspector-kicker">Worktree</p>
            <div className="status-inline-meta">${worktreePath}</div>
          </div>
        </aside>
        <main className="status-shell-main">
          <div className="status-shell-graph">
            <div className="status-shell-graph-header">
              <div>
                <div
                  className="status-shell-line"
                  style=${{ width: "220px" }}
                ></div>
                <div
                  className="status-shell-line-short"
                  style=${{ width: "320px", marginTop: "10px" }}
                ></div>
              </div>
              <div
                className="status-shell-chip"
                style=${{ width: "180px" }}
              ></div>
            </div>
            <div
              className="status-phase-track"
              style=${{ marginBottom: "18px" }}
            >
              ${STATUS_PHASES.map(
                (entry, index) =>
                  html`<div
                    key=${entry.key}
                    className=${`status-phase-step ${index === activePhaseIndex ? "active" : index < activePhaseIndex ? "complete" : ""}`}
                  >
                    <span className="status-phase-dot"></span>
                    <span className="status-phase-label">${entry.label}</span>
                  </div>`,
              )}
            </div>
            <div className="status-shell-graph-canvas">
              ${skeletonNodes.map(
                (node) =>
                  html`<div
                    key=${`${node.left}-${node.top}`}
                    className=${`status-loading-node ${node.size}`.trim()}
                    style=${{ left: `${node.left}px`, top: `${node.top}px` }}
                  ></div>`,
              )}
              <div
                className="status-loading-line"
                style=${{
                  left: "196px",
                  top: "103px",
                  width: "160px",
                  transform: "rotate(8deg)",
                }}
              ></div>
              <div
                className="status-loading-line"
                style=${{
                  left: "428px",
                  top: "86px",
                  width: "186px",
                  transform: "rotate(18deg)",
                }}
              ></div>
              <div
                className="status-loading-line"
                style=${{
                  left: "662px",
                  top: "138px",
                  width: "168px",
                  transform: "rotate(-14deg)",
                }}
              ></div>
              <div
                className="status-shell-graph-pill"
                style=${{
                  position: "absolute",
                  left: "22px",
                  bottom: "24px",
                  width: "280px",
                  height: "86px",
                }}
              >
                <div
                  className="status-shell-sidebar-card"
                  style=${{
                    margin: "0",
                    border: "none",
                    background: "transparent",
                  }}
                >
                  <div
                    className="status-shell-line"
                    style=${{ width: "66%" }}
                  ></div>
                  <div
                    className="status-shell-line-short"
                    style=${{ width: "48%" }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
          <div
            style=${{
              position: "absolute",
              left: "18px",
              right: "18px",
              bottom: "18px",
            }}
          >
            <div className="status-shell-sidebar-card">
              <div
                className="status-shell-line"
                style=${{ width: "34%" }}
              ></div>
              <div
                className="status-shell-line-short"
                style=${{ width: "86%" }}
              ></div>
              ${highlights?.length
                ? html`<div className="viewer-debug-chip-row">
                    ${highlights
                      .slice(0, 4)
                      .map(
                        (item) =>
                          html`<span key=${item} className="viewer-debug-chip"
                            >${item}</span
                          >`,
                      )}
                  </div>`
                : null}
              <div className="status-inline-meta">
                ${message} · ${worktreePath}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  `;
}

function SessionDebugDrawer({ open, payload, onClose }) {
  if (!open) {
    return null;
  }

  try {
    const reviewDebug = payload.reviewDebug ?? null;
    const metrics = getViewerDebugMetrics(payload);
    const reviewSnapshot = formatDebugValue(reviewDebug?.snapshot ?? null);
    const reviewPrompt = formatDebugValue(reviewDebug?.prompt ?? null);
    const openCodeSession = formatDebugValue(reviewDebug?.openCode ?? null);
    const openCodeSummary = reviewDebug?.openCode ?? null;
    const openCodeSessionId = openCodeSummary?.sessionId ?? "—";
    const openCodeAgent = openCodeSummary?.agent ?? "—";
    const openCodeModel = getOpenCodeModelLabel(reviewDebug);
    const openCodeMessageCount = Array.isArray(openCodeSummary?.messages)
      ? openCodeSummary.messages.length
      : 0;
    const liveEntries = getOpenCodeLiveEntries(reviewDebug);
    const liveLog = liveEntries.length
      ? liveEntries
          .map((entry) => `[${entry.role}] ${entry.summary}`)
          .join("\n\n")
      : "Waiting for OpenCode to emit its first live update.";
    window.__lastDebugDrawerError = null;

    return html`
      <div>
        <div className="viewer-debug-backdrop" onClick=${onClose}></div>
        <aside
          className="viewer-debug-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Session debug drawer"
        >
          <div className="viewer-debug-drawer-header">
            <h2 className="viewer-debug-drawer-title">Session debug</h2>
            <button className="viewer-debug-toggle" onClick=${onClose}>
              Close
            </button>
          </div>
          <div className="viewer-debug-drawer-body">
            <div className="viewer-debug-chip-row">
              ${metrics.map(
                (metric) =>
                  html`<span key=${metric.label} className="viewer-debug-chip"
                    >${metric.label}: ${metric.value}</span
                  >`,
              )}
              <span className="viewer-debug-chip"
                >Session: ${openCodeSessionId}</span
              >
              <span className="viewer-debug-chip">Agent: ${openCodeAgent}</span>
              <span className="viewer-debug-chip">Model: ${openCodeModel}</span>
              <span className="viewer-debug-chip"
                >Messages: ${openCodeMessageCount}</span
              >
            </div>
            <div className="viewer-debug-card">
              <h3 className="viewer-debug-section-title">OpenCode live log</h3>
              <pre className="viewer-debug-pre">${liveLog}</pre>
            </div>
            <div className="viewer-debug-card">
              <h3 className="viewer-debug-section-title">
                OpenReview snapshot
              </h3>
              <pre className="viewer-debug-pre">${reviewSnapshot}</pre>
            </div>
            <div className="viewer-debug-card">
              <h3 className="viewer-debug-section-title">
                Prompt sent to OpenCode
              </h3>
              <pre className="viewer-debug-pre">${reviewPrompt}</pre>
            </div>
            <div className="viewer-debug-card">
              <h3 className="viewer-debug-section-title">OpenCode session</h3>
              <pre className="viewer-debug-pre">${openCodeSession}</pre>
            </div>
          </div>
        </aside>
      </div>
    `;
  } catch (error) {
    window.__lastDebugDrawerError =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    return html`
      <div>
        <div className="viewer-debug-backdrop" onClick=${onClose}></div>
        <aside
          className="viewer-debug-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Session debug drawer"
        >
          <div className="viewer-debug-drawer-header">
            <h2 className="viewer-debug-drawer-title">Session debug</h2>
            <button className="viewer-debug-toggle" onClick=${onClose}>
              Close
            </button>
          </div>
          <div className="viewer-debug-drawer-body">
            <div className="viewer-debug-card">
              <h3 className="viewer-debug-section-title">
                Debug drawer render error
              </h3>
              <pre className="viewer-debug-pre">
${window.__lastDebugDrawerError}</pre
              >
            </div>
          </div>
        </aside>
      </div>
    `;
  }
}

function setDebugDrawerOpen(open) {
  const nextUrl = new URL(window.location.href);

  if (open) {
    nextUrl.searchParams.set("debug", "1");
  } else {
    nextUrl.searchParams.delete("debug");
  }

  window.location.replace(nextUrl.toString());
}

function BasicStatusPage({
  title,
  message,
  worktreePath,
  tone,
  detail = null,
  actions = null,
}) {
  return html`
    <div className="status-page viewer-root">
      <section className="status-card">
        <div className="status-pill">${title}</div>
        <div className="status-hero">
          <div className=${`status-orb ${tone ?? "loading"}`}></div>
          <div className="status-copy">
            <h1>${title}</h1>
            <p>${message}</p>
          </div>
        </div>
        ${tone === "loading"
          ? html`<div className="status-skeleton">
              <div className="status-skeleton-line"></div>
              <div className="status-skeleton-line"></div>
              <div className="status-skeleton-line short"></div>
            </div>`
          : null}
        ${detail ? html`<p className="inspector-copy">${detail}</p>` : null}
        <div className="status-meta">
          <span>Worktree</span>
          <code>${worktreePath}</code>
        </div>
        ${actions
          ? html`<div className="status-footer">${actions}</div>`
          : null}
      </section>
    </div>
  `;
}

function LoadingSummaryPanel({ title, message, phaseIndex }) {
  const currentPhase = STATUS_PHASES[phaseIndex] ?? STATUS_PHASES[0];
  const nextPhase = STATUS_PHASES[phaseIndex + 1] ?? null;
  return html`
    <section className="inspector-summary-card">
      <p className="inspector-kicker">Review Progress</p>
      <h2 className="inspector-summary-title">${title}</h2>
      <p className="inspector-summary-copy">${message}</p>
      <div className="inspector-stat-grid">
        <div className="inspector-stat-pill changed">
          ${phaseIndex + 1} / ${STATUS_PHASES.length} stages
        </div>
        <div className="inspector-stat-pill">${currentPhase.label} active</div>
        <div className="inspector-stat-pill">
          ${nextPhase ? `Next: ${nextPhase.label}` : "Finalizing view"}
        </div>
        <div className="inspector-stat-pill">Live viewer shell ready</div>
      </div>
    </section>
  `;
}

function StatusPage({
  title,
  message,
  worktreePath,
  tone,
  phase,
  detail,
  highlights,
  generatedAt,
  reviewDebug,
  sessionDebug,
}) {
  const [retryState, setRetryState] = useState("idle");
  const [retryMessage, setRetryMessage] = useState("");
  const retryPort = sessionDebug?.viewer?.controlPort ?? null;

  const handleRetry = async () => {
    if (
      !(typeof retryPort === "number" && retryPort > 0) ||
      retryState === "running"
    ) {
      return;
    }

    setRetryState("running");
    setRetryMessage("");

    try {
      const response = await fetch(
        `http://127.0.0.1:${retryPort}/control/retry`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error(`Retry request failed with status ${response.status}.`);
      }
      setRetryMessage(
        "Waiting for the OpenReview service to restart the review.",
      );
    } catch (error) {
      setRetryState("idle");
      setRetryMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (tone !== "loading") {
    return html`<${BasicStatusPage}
      title=${title}
      message=${retryState === "running"
        ? "Retrying OpenReview and rebuilding the viewer shell."
        : message}
      worktreePath=${worktreePath}
      tone=${tone}
      detail=${retryMessage || detail}
      actions=${tone === "error"
        ? html`
            <button
              className="git-review-action"
              onClick=${() => setDebugDrawerOpen(true)}
            >
              Show debug
            </button>
            <button
              className="git-review-action git-review-action-primary"
              onClick=${handleRetry}
              disabled=${retryState === "running" ||
              !(typeof retryPort === "number" && retryPort > 0)}
            >
              ${retryState === "running" ? "Retrying…" : "Try again"}
            </button>
          `
        : null}
    />`;
  }
  return html`<${StatusSkeletonShell}
    title=${title}
    message=${message}
    worktreePath=${worktreePath}
    phase=${phase}
    highlights=${highlights}
    reviewDebug=${reviewDebug}
    sessionDebug=${sessionDebug}
  />`;
}

function InsightContent({ insight, emptyMessage, onClear }) {
  if (!insight) {
    return html`
      <div className="file-panel-card">
        <div className="file-panel-header">
          <h2>File insight</h2>
        </div>
        <p className="file-panel-empty">${emptyMessage}</p>
      </div>
    `;
  }

  const riskSignals = insight.riskSignals?.length
    ? insight.riskSignals
    : ["low-risk"];
  const commitSuffix = insight.lastCommitHash
    ? ` · ${insight.lastCommitHash.slice(0, 8)}`
    : "";
  const insightSource =
    insight.summarySource === "same-prompt-openCode"
      ? "Generated in the primary OpenReview pass."
      : "Fallback heuristic summary until richer OpenReview enrichment lands.";

  return html`
    <div className="file-panel-card">
      <div className="file-panel-header">
        <h2>File insight</h2>
        ${onClear
          ? html`<button
              className="panel-close"
              onClick=${onClear}
              aria-label="Clear file context"
            >
              ×
            </button>`
          : null}
      </div>
      <p className="file-path"><code>${insight.path}</code>${commitSuffix}</p>
      <div className="risk-chips">
        <span className="risk-chip">${insight.state}</span>
        ${riskSignals.map(
          (riskSignal) =>
            html`<span key=${riskSignal} className="risk-chip"
              >${riskSignal}</span
            >`,
        )}
      </div>
      <p className="insight-source">${insightSource}</p>
      <h3>Summary</h3>
      <p className="file-summary">${insight.summary}</p>
      <div className="file-stat-grid">
        <div className="file-stat">
          <span className="file-stat-label">Commits / 30d</span
          ><span className="file-stat-value"
            >${insight.recentCommitCount30d}</span
          >
        </div>
        <div className="file-stat">
          <span className="file-stat-label">Churn score</span
          ><span className="file-stat-value">${insight.churnScore}</span>
        </div>
        <div className="file-stat">
          <span className="file-stat-label">Authors / 30d</span
          ><span className="file-stat-value">${insight.uniqueAuthors30d}</span>
        </div>
        <div className="file-stat">
          <span className="file-stat-label">Lines touched</span
          ><span className="file-stat-value"
            >+${insight.linesAdded30d} / -${insight.linesDeleted30d}</span
          >
        </div>
      </div>
      <h3>Recent changes</h3>
      <p>${insight.changeSummary}</p>
      <h3>Impact summary</h3>
      <p>${insight.impactSummary}</p>
      <h3>Modification risk</h3>
      <p>${insight.riskSummary}</p>
      ${insight.impactSources?.length
        ? html`<div>
            <p className="graph-section-label">Impact sources</p>
            <div className="risk-chips">
              ${insight.impactSources.map(
                (value) =>
                  html`<span key=${value} className="risk-chip"
                    >${value}</span
                  >`,
              )}
            </div>
          </div>`
        : null}
      ${insight.impactReasons?.length
        ? html`<div>
            <p className="graph-section-label">Impact reasons</p>
            <div className="risk-chips">
              ${insight.impactReasons.map(
                (value) =>
                  html`<span key=${value} className="risk-chip"
                    >${value}</span
                  >`,
              )}
            </div>
          </div>`
        : null}
    </div>
  `;
}

function MarkdownContent({
  markdown,
  fileInsights,
  selectedPath,
  onSelectPath,
}) {
  const contentRef = useRef(null);
  const resolveFileInsight = useMemo(
    () => buildResolver(fileInsights ?? {}),
    [fileInsights],
  );
  const renderedMarkdown = useMemo(() => {
    const source = String(markdown ?? "");
    try {
      return marked.parse(source, {
        breaks: true,
        gfm: true,
      });
    } catch {
      return `<pre>${escapeHtml(source)}</pre>`;
    }
  }, [markdown]);

  useEffect(() => {
    const rootElement = contentRef.current;
    if (!rootElement) {
      return;
    }

    const attachFileReference = (element, rawValue) => {
      const insight = resolveFileInsight(rawValue);
      if (!insight?.path) {
        return;
      }

      element.dataset.openreviewPath = insight.path;
      element.style.cursor = "pointer";
      element.setAttribute("title", `Inspect ${insight.path}`);

      if (element.tagName === "A") {
        element.setAttribute("href", "#");
      } else {
        element.setAttribute("role", "button");
        element.setAttribute("tabindex", "0");
      }
    };

    rootElement.querySelectorAll("a[href]").forEach((anchor) => {
      attachFileReference(
        anchor,
        anchor.getAttribute("href") ?? anchor.textContent ?? "",
      );
    });

    rootElement.querySelectorAll("code").forEach((codeElement) => {
      if (codeElement.closest("pre")) {
        return;
      }

      attachFileReference(codeElement, codeElement.textContent ?? "");
    });

    const activateSelection = (target) => {
      const trigger = target?.closest?.("[data-openreview-path]");
      const nextPath = trigger?.dataset?.openreviewPath;
      if (!nextPath || typeof onSelectPath !== "function") {
        return false;
      }

      onSelectPath(nextPath === selectedPath ? null : nextPath);
      return true;
    };

    const handleClick = (event) => {
      if (!activateSelection(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyDown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      if (!activateSelection(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    rootElement.addEventListener("click", handleClick);
    rootElement.addEventListener("keydown", handleKeyDown);

    const renderMermaid = async () => {
      const mermaidCodeBlocks = Array.from(
        rootElement.querySelectorAll(
          "pre > code.language-mermaid, pre > code.lang-mermaid",
        ),
      );
      if (!mermaidCodeBlocks.length) {
        return;
      }

      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "dark",
        });
        mermaidInitialized = true;
      }

      const mermaidNodes = mermaidCodeBlocks.map((codeElement, index) => {
        const preElement = codeElement.parentElement;
        const diagramElement = document.createElement("div");
        diagramElement.className = "mermaid";
        diagramElement.id = `openreview-mermaid-${index}-${Date.now()}`;
        diagramElement.textContent = codeElement.textContent ?? "";
        preElement?.replaceWith(diagramElement);
        return diagramElement;
      });

      if (!mermaidNodes.length) {
        return;
      }

      try {
        await mermaid.run({ nodes: mermaidNodes });
      } catch (error) {
        console.error("Failed to render Mermaid diagrams", error);
      }
    };

    void renderMermaid();

    return () => {
      rootElement.removeEventListener("click", handleClick);
      rootElement.removeEventListener("keydown", handleKeyDown);
    };
  }, [fileInsights, onSelectPath, renderedMarkdown, resolveFileInsight, selectedPath]);

  return html`<div
    id="content"
    ref=${contentRef}
    dangerouslySetInnerHTML=${{ __html: renderedMarkdown }}
  ></div>`;
}

function DocumentPage({ payload }) {
  const fileInsights = payload.fileInsightsIndex?.files ?? {};
  const [selectedPath, setSelectedPath] = useState(null);
  const selectedInsight = selectedPath
    ? (fileInsights[selectedPath] ?? null)
    : null;
  const changedCount = Object.values(fileInsights).filter(
    (insight) => insight.state === "changed",
  ).length;
  const affectedCount = Object.values(fileInsights).filter(
    (insight) => insight.state === "impacted",
  ).length;
  const inspector = useResizablePanel({
    storageKey: INSPECTOR_WIDTH_KEY,
    defaultWidth: DEFAULT_INSPECTOR_WIDTH,
    direction: "right",
  });

  return html`
    <div className="content-shell viewer-root" style=${inspector.shellStyle}>
      <main className="document-main">
        <header className="page-header">
          <div>
            <h1 className="page-title">
              ${payload.doc?.title ?? "OpenReview"}
            </h1>
            <p className="page-subtitle">${payload.statusText}</p>
          </div>
        </header>
        <article className="content content-standalone">
          <${MarkdownContent}
            markdown=${payload.markdown ?? ""}
            fileInsights=${fileInsights}
            selectedPath=${selectedPath}
            onSelectPath=${setSelectedPath}
          />
        </article>
      </main>
      <div
        className="inspector-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details panel"
        onPointerDown=${inspector.onPointerDown}
        onMouseDown=${inspector.onMouseDown}
      >
        <span className="inspector-resize-grip" aria-hidden="true">⋮</span>
      </div>
      <aside className="inspector-panel" style=${inspector.panelStyle}>
        <section className="inspector-summary-card">
          <h2 className="inspector-summary-title">
            ${payload.doc?.title ?? "OpenReview"}
          </h2>
          <p className="inspector-summary-copy inspector-summary-copy-tight">
            ${changedCount} changed and ${affectedCount} affected files in
            scope.
          </p>
        </section>
        <div className="inspector-detail-panel">
          <${InsightContent}
            insight=${selectedInsight}
            emptyMessage="Click a file path in the doc or any file-labeled diagram node to inspect recent changes and risk signals."
            onClear=${selectedInsight ? () => setSelectedPath(null) : null}
          />
        </div>
      </aside>
    </div>
  `;
}

function getNodeVisualState(node, insight) {
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

function getNodeMeta(node, insight, groupContext = "") {
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

function InspectorPill({ label, onClick }) {
  return html`<button className="inspector-pill" onClick=${onClick}>
    ${label}
  </button>`;
}

function formatFindingLabel(value) {
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

function getFindingIcon(value) {
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

function getFindingCategoryLabel(value) {
  return value === "typecheck"
    ? "Typecheck"
    : String(value ?? "risk").replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeIssues(issues = []) {
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
      getSeverityRank(issue.severity) >
        getSeverityRank(summary.primaryIssue.severity)
    ) {
      summary.primaryIssue = issue;
      summary.primarySeverity = issue.severity;
    }
  }

  summary.primaryCount = summary[summary.primarySeverity ?? "info"] ?? 0;
  return summary;
}

function getIssueMarkerLabel(summary) {
  if (!summary?.primarySeverity) {
    return "";
  }

  return `${getFindingIcon(summary.primarySeverity)} ${summary.primaryCount}`;
}

function getIssueMarkerTitle(summary) {
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

function buildFindingsFromInsight({ insight, nodeLabel }) {
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

  if (findings.length) {
    return findings;
  }

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

function getInterfaceSuggestion(finding) {
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

function getPromptPreview(prompt) {
  const lines = String(prompt ?? "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return lines.join("\n");
}

function getCodePreviewSnippet(code) {
  return String(code ?? "")
    .trim()
    .split("\n")
    .slice(0, 8)
    .join("\n");
}

function getInterfaceBeforePreview(finding) {
  return String(finding?.current || finding?.before || "").trim();
}

function getInterfaceAfterPreview(finding) {
  return String(
    finding?.suggestions?.[0]?.better || finding?.better || "",
  ).trim();
}

function renderInterfaceChangePreview(
  finding,
  { compact = false, beforeLabel = "Current", afterLabel = "After" } = {},
) {
  const beforePreview = getInterfaceBeforePreview(finding);
  const afterPreview = getInterfaceAfterPreview(finding);

  if (!beforePreview && !afterPreview) {
    return null;
  }

  return html`
    <div
      className=${`interface-change-grid ${compact ? "interface-change-grid-compact" : ""}`}
    >
      <section
        className="interface-change-snapshot interface-change-snapshot-before"
      >
        <p className="interface-change-label">${beforeLabel}</p>
        <div className="finding-code-preview interface-change-preview">
          <pre><code>${beforePreview ||
          "No current interface preview available."}</code></pre>
        </div>
      </section>
      <section
        className="interface-change-snapshot interface-change-snapshot-after"
      >
        <p className="interface-change-label">${afterLabel}</p>
        <div className="finding-code-preview interface-change-preview">
          <pre><code>${afterPreview ||
          "No recommended interface preview available."}</code></pre>
        </div>
      </section>
    </div>
  `;
}

function InterfaceSuggestionCard({
  title,
  path,
  consumerLabel,
  current,
  suggestions,
}) {
  return html`
    <div className="interface-diff-card">
      <div className="interface-diff-head">
        <div>
          <p className="inspector-kicker">Interface improvement</p>
          <h3 className="interface-diff-title">${title}</h3>
          <p className="interface-diff-meta">${path}</p>
        </div>
        ${consumerLabel
          ? html`<span className="interface-impact-badge"
              >${consumerLabel}</span
            >`
          : null}
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Current interface</p>
        <div className="finding-code-preview">
          <pre><code>${current ||
          "No current interface preview available."}</code></pre>
        </div>
      </div>
      ${suggestions?.length
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Better interface options</p>
            <div className="review-findings-groups">
              ${suggestions.map(
                (suggestion, index) =>
                  html`<div
                    key=${`${suggestion.label}:${index}`}
                    className="inspector-list-item static interface-improvement-card"
                  >
                    <div>
                      <div className="finding-title-row">
                        <strong
                          >${suggestion.label || `Option ${index + 1}`}</strong
                        >
                      </div>
                      <div className="finding-code-preview">
                        <pre><code>${suggestion.better}</code></pre>
                      </div>
                      ${suggestion.whyBetter
                        ? html`<p className="interface-diff-insight">
                            <strong>Why this is better for callers:</strong>
                            ${suggestion.whyBetter}
                          </p>`
                        : null}
                      ${suggestion.tradeoff
                        ? html`<p
                            className="inspector-copy inspector-copy-secondary"
                          >
                            <strong>Tradeoff:</strong> ${suggestion.tradeoff}
                          </p>`
                        : null}
                    </div>
                  </div>`,
              )}
            </div>
          </div>`
        : null}
    </div>
  `;
}

function getFindingsForInterfaceItem({ item, findings }) {
  return findings.filter((finding) => {
    const findingPath = finding.path;
    if (findingPath !== item.path) {
      return false;
    }
    const haystack = [
      finding.title,
      finding.detail,
      finding.codePreview,
      finding.contract?.name,
      finding.contract?.declaration,
      finding.functionName,
      finding.location,
      finding.better,
      finding.current,
    ]
      .filter(Boolean)
      .join("\n");
    return haystack.includes(item.name);
  });
}

function FindingsList({ findings, onSelectIssue }) {
  if (!findings.length) {
    return html`<p className="inspector-copy">
      No concrete interface improvements were generated for this scope.
    </p>`;
  }

  const groups = ["risk", "warning", "info"]
    .map((severity) => ({
      severity,
      items: findings.filter((finding) => finding.severity === severity),
    }))
    .filter((group) => group.items.length > 0);

  return html`
    <div className="review-findings-groups">
      ${groups.map(
        (group) =>
          html`<section key=${group.severity} className="review-findings-group">
            <div className="review-findings-group-head">
              <span className=${`finding-icon finding-icon-${group.severity}`}
                >${getFindingIcon(group.severity)}</span
              >
              <strong
                >${group.severity === "risk"
                  ? "High-priority improvements"
                  : group.severity === "warning"
                    ? "Suggested improvements"
                    : "Notes"}</strong
              >
              <span className="inspector-list-meta">${group.items.length}</span>
            </div>
            <div
              className="inspector-list inspector-list-compact review-findings-list"
            >
              ${group.items.map(
                (finding) =>
                  html`<div
                    key=${finding.id}
                    className=${`inspector-list-item static finding-item finding-${finding.severity}`}
                  >
                    <div>
                      <div className="finding-title-row">
                        <span
                          className=${`finding-icon finding-icon-${finding.severity}`}
                          >${getFindingIcon(finding.severity)}</span
                        >
                        <strong>${finding.title}</strong>
                        <span className="finding-domain-chip"
                          >${getFindingCategoryLabel(finding.category)}</span
                        >
                      </div>
                      <p className="finding-copy">
                        ${finding.detail ||
                        finding.problem ||
                        getInterfaceSuggestion(finding)}
                      </p>
                      ${isCombineOpportunity(finding)
                        ? html`<div className="inspector-pill-grid">
                            <span className="inspector-pill"
                              >Strategy:
                              ${getSimplificationStrategyLabel(
                                finding.simplificationStrategy,
                              )}</span
                            >
                            ${finding.combineWith?.map(
                              (entry) =>
                                html`<span
                                  key=${entry}
                                  className="inspector-pill"
                                  >Combine with: ${entry}</span
                                >`,
                            )}
                          </div>`
                        : null}
                      ${renderInterfaceChangePreview(finding, {
                        compact: true,
                        afterLabel: "After (recommended)",
                      }) ||
                      (finding.codePreview
                        ? html`<div className="finding-code-preview">
                            <pre><code>${getCodePreviewSnippet(
                              finding.codePreview,
                            )}</code></pre>
                          </div>`
                        : null)}
                      ${finding.whyBetter
                        ? html`<p className="interface-change-explainer">
                            <strong>Why this is better:</strong>
                            ${finding.whyBetter}
                          </p>`
                        : null}
                      <div className="finding-actions">
                        <button
                          className="finding-action-button finding-action-button-primary"
                          onClick=${() => onSelectIssue?.(finding)}
                        >
                          Fix in OpenCode
                        </button>
                      </div>
                    </div>
                    ${finding.location || finding.path
                      ? html`<span className="inspector-list-meta"
                          >${finding.location || finding.path}</span
                        >`
                      : null}
                  </div>`,
              )}
            </div>
          </section>`,
      )}
    </div>
  `;
}

function DiffFileList({
  items,
  onSelectNode,
  emptyMessage = "No diff items in this scope.",
}) {
  return html`<div className="inspector-list inspector-list-compact">
    ${items.length
      ? items.map(
          (item) =>
            html`<button
              key=${item.path}
              className="inspector-list-item"
              onClick=${() =>
                item.nodeId
                  ? onSelectNode({
                      id: item.nodeId,
                      label: item.path.split("/").slice(-1)[0],
                      path: item.path,
                    })
                  : null}
            >
              <span>${item.path}</span>
              <span className="inspector-list-meta"
                >${item.status} · +${item.insertions}/-${item.deletions}</span
              >
            </button>`,
        )
      : html`<div className="inspector-list-item static muted">
          <span>${emptyMessage}</span>
        </div>`}
  </div>`;
}

function getAvailableCompareBranches({
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

  const options = allOptions.filter((option) => option !== currentBranch);

  const preferredDefaults = ["main", "origin/main"];
  const sortedOptions = options.sort((left, right) => {
    const leftPriority = preferredDefaults.indexOf(left);
    const rightPriority = preferredDefaults.indexOf(right);
    if (leftPriority !== -1 || rightPriority !== -1) {
      if (leftPriority === -1) return 1;
      if (rightPriority === -1) return -1;
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });

  if (!sortedOptions.length && currentBranch) {
    return [currentBranch];
  }

  return sortedOptions;
}

function getPreferredCompareBranch(compareOptions, fallbackBranch = "") {
  if (compareOptions.includes("main")) {
    return "main";
  }

  return fallbackBranch && compareOptions.includes(fallbackBranch)
    ? fallbackBranch
    : (compareOptions[0] ?? "");
}

function GitReviewBranchDropdown({
  compareBranch,
  compareOptions,
  setCompareBranch,
  loading,
}) {
  const hasOptions = compareOptions.length > 0;
  const selectValue = hasOptions && compareBranch ? compareBranch : "";

  return html`
    <div className="git-review-combobox">
      <select
        className="git-review-select"
        value=${selectValue}
        onChange=${(event) => setCompareBranch(event.currentTarget.value)}
        disabled=${!hasOptions}
      >
        ${hasOptions
          ? [
              !compareBranch
                ? html`<option value="" disabled>Select compare branch</option>`
                : null,
              ...compareOptions.map(
                (option) =>
                  html`<option key=${option} value=${option}>
                    ${option}
                  </option>`,
              ),
            ]
          : html`<option value="">
              ${loading ? "Loading branches…" : "Current branch only"}
            </option>`}
      </select>
    </div>
  `;
}

function GitReviewTopbar({
  currentBranch,
  compareBranch,
  compareOptions,
  setCompareBranch,
  compareOptionsLoading,
  graphSummary,
  worktreePath,
  reviewControlPort,
  onReexamine,
  reexamineState,
  reexamineMessage,
  debugOpen,
  onToggleDebug,
}) {
  const reexamineDisabled = reexamineState === "running";

  return html`
    <section className="git-review-topbar">
      <div className="git-review-left">
        <${GitReviewBranchDropdown}
          compareBranch=${compareBranch}
          compareOptions=${compareOptions}
          setCompareBranch=${setCompareBranch}
          loading=${compareOptionsLoading}
        />
        <span className="git-review-arrow">←</span>
        <span className="git-review-branch-name">${currentBranch}</span>
      </div>
      <div className="git-review-right">
        <button className="git-review-action" onClick=${onToggleDebug}>
          ${debugOpen ? "Hide debug" : "Show debug"}
        </button>
        <button
          className="git-review-action git-review-action-primary"
          onClick=${onReexamine}
          disabled=${reexamineDisabled}
        >
          ${reexamineState === "running" ? "Reexamining…" : "Reexamine"}
        </button>
      </div>
    </section>
    ${reexamineMessage
      ? html`<p className="inspector-copy inspector-copy-secondary">
          ${reexamineMessage}
        </p>`
      : null}
  `;
}

function IssueFixerPanel({
  issue,
  fixPrompt,
  setFixPrompt,
  compareBranch,
  currentBranch,
  activeComparison,
  issueDiffFile,
  relatedFiles,
  reviewControlPort,
  reviewControlToken,
  onClose,
}) {
  const [copied, setCopied] = useState(false);
  const [sendState, setSendState] = useState("idle");
  const [sendMessage, setSendMessage] = useState("");
  const includedFiles = useMemo(() => {
    const next = [];
    const seen = new Set();

    [issueDiffFile, ...(relatedFiles ?? [])].forEach((file) => {
      const filePath =
        file && typeof file.path === "string" ? file.path.trim() : "";
      if (!filePath || seen.has(filePath)) {
        return;
      }
      seen.add(filePath);
      next.push(filePath);
    });

    return next;
  }, [issueDiffFile, relatedFiles]);

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(fixPrompt);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      setCopied(false);
    }
  };

  const handleFix = async () => {
    if (!(typeof reviewControlPort === "number" && reviewControlPort > 0)) {
      setSendState("error");
      setSendMessage(
        "OpenCode handoff is unavailable while the viewer service is offline.",
      );
      return;
    }

    setSendState("sending");
    setSendMessage("");

    try {
      const response = await fetch(
        `http://127.0.0.1:${reviewControlPort}/control/fix-prompt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(reviewControlToken
              ? { "X-OpenReview-Control-Token": reviewControlToken }
              : {}),
          },
          body: JSON.stringify({ prompt: fixPrompt, files: includedFiles }),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.error ??
            `Fix handoff failed with status ${response.status}.`,
        );
      }

      setSendState("sent");
      setSendMessage("OpenCode opened on the far right with this prompt.");
    } catch (error) {
      setSendState("error");
      setSendMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const codeLocation = parseCodeLocation(
    issue.location ?? issue.contract?.path ?? issue.path ?? "",
    "",
  );

  return html`
    <div className="issue-fixer-shell">
      <div className="issue-fixer-action-card">
        <div className="inspector-header-row">
          <div>
            <p className="inspector-kicker">Recommended interface change</p>
            <h2 className="inspector-title">
              ${issue.functionName || issue.title}
            </h2>
            ${codeLocation?.label
              ? html`<p className="inspector-copy inspector-copy-secondary">
                  ${codeLocation.label}
                </p>`
              : null}
          </div>
          <button className="inspector-inline-action" onClick=${onClose}>
            Back
          </button>
        </div>
        <p className="inspector-copy issue-fixer-copy">
          ${issue.problem || issue.detail || getInterfaceSuggestion(issue)}
        </p>
        ${isCombineOpportunity(issue)
          ? html`<div className="inspector-section">
              <p className="inspector-kicker">Simplify by combining</p>
              <div className="inspector-pill-grid">
                <span className="inspector-pill"
                  >Strategy:
                  ${getSimplificationStrategyLabel(
                    issue.simplificationStrategy,
                  )}</span
                >
                ${issue.combineWith?.map(
                  (entry) =>
                    html`<span key=${entry} className="inspector-pill"
                      >${entry}</span
                    >`,
                )}
              </div>
              <p className="inspector-copy inspector-copy-secondary">
                This looks like one consumer job spread across multiple methods.
                Prefer one clear function instead of making callers choose
                between near-duplicates.
              </p>
            </div>`
          : null}
        ${renderInterfaceChangePreview(issue, {
          afterLabel: "After (recommended)",
        })}
        ${issue.whyBetter
          ? html`<p className="interface-change-explainer">
              <strong>Why this is better:</strong> ${issue.whyBetter}
            </p>`
          : null}
        ${issue.suggestions?.length
          ? html`<div className="inspector-section">
              <p className="inspector-kicker">Options</p>
              <div className="review-findings-groups">
                ${issue.suggestions.map(
                  (suggestion, index) =>
                    html`<div
                      key=${`${suggestion.label}:${index}`}
                      className="inspector-list-item static interface-improvement-card"
                    >
                      <div>
                        <strong
                          >${suggestion.label || `Option ${index + 1}`}</strong
                        >
                        <div className="finding-code-preview">
                          <pre><code>${suggestion.better}</code></pre>
                        </div>
                        ${suggestion.whyBetter
                          ? html`<p
                              className="inspector-copy inspector-copy-secondary"
                            >
                              ${suggestion.whyBetter}
                            </p>`
                          : null}
                        ${suggestion.tradeoff
                          ? html`<p
                              className="inspector-copy inspector-copy-secondary"
                            >
                              <strong>Tradeoff:</strong> ${suggestion.tradeoff}
                            </p>`
                          : null}
                      </div>
                    </div>`,
                )}
              </div>
            </div>`
          : null}
        ${issue.contract
          ? html`<div className="inspector-section">
              <p className="inspector-kicker">Why this function matters</p>
              <p className="inspector-copy issue-fixer-copy">
                <strong>${issue.contract.name}</strong> in
                <code>${issue.contract.path}</code>
              </p>
              <div className="file-stat-grid">
                <div className="file-stat">
                  <span className="file-stat-label">Consumer fanout</span>
                  <span className="file-stat-value"
                    >${issue.contract.consumerParts?.length || 0}</span
                  >
                </div>
                <div className="file-stat">
                  <span className="file-stat-label">Target</span>
                  <span className="file-stat-value">Better after</span>
                </div>
              </div>
              ${issue.contract.consumerParts?.length
                ? html`<div className="inspector-pill-grid">
                    ${issue.contract.consumerParts.map(
                      (part) =>
                        html`<span key=${part} className="inspector-pill"
                          >${part}</span
                        >`,
                    )}
                  </div>`
                : html`<p className="inspector-copy inspector-copy-secondary">
                    No external consumers were detected for this contract yet.
                  </p>`}
              <${InterfaceSuggestionCard}
                title=${issue.contract.name}
                path=${codeLocation?.label ?? issue.contract.path}
                consumerLabel=${issue.contract.consumerParts?.length
                  ? `${issue.contract.consumerParts.length} consumers affected`
                  : ""}
                current=${issue.current ||
                issue.contract.currentDeclaration ||
                issue.contract.previewSnippet ||
                issue.contract.declaration}
                suggestions=${issue.suggestions ?? []}
              />
            </div>`
          : null}
        <label className="issue-fixer-label" for="issue-fix-prompt"
          >Edit improvement prompt</label
        >
        <textarea
          id="issue-fix-prompt"
          className="issue-fixer-textarea"
          value=${fixPrompt}
          onInput=${(event) => setFixPrompt(event.currentTarget.value)}
          rows=${3}
        ></textarea>
        ${includedFiles.length
          ? html`<p className="issue-fixer-note">
              OpenCode will include:
              <strong>${includedFiles.join(", ")}</strong>
            </p>`
          : null}
        <div className="inspector-action-row">
          <button
            className="btn-fix-primary"
            onClick=${handleFix}
            disabled=${sendState === "sending"}
          >
            ${sendState === "sending" ? "Sending…" : "Fix in OpenCode"}
          </button>
          <button className="inspector-inline-action" onClick=${handleCopy}>
            ${copied ? "Copied" : "Copy prompt"}
          </button>
        </div>
        <p className="issue-fixer-note">
          ${sendMessage ||
          "Use this prompt to implement the suggested interface directly in OpenCode, or copy and refine it manually."}
        </p>
      </div>
    </div>
  `;
}

function PromptSuggestionCard({
  issue,
  reviewControlPort,
  reviewControlToken,
  initiallyExpanded = false,
}) {
  const [prompt, setPrompt] = useState(issue.fixPrompt ?? "");
  const [copied, setCopied] = useState(false);
  const [sendState, setSendState] = useState("idle");
  const [sendMessage, setSendMessage] = useState("");

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      setCopied(false);
    }
  };

  const handleFix = async () => {
    if (!(typeof reviewControlPort === "number" && reviewControlPort > 0)) {
      setSendState("error");
      setSendMessage(
        "OpenCode handoff is unavailable while the viewer service is offline.",
      );
      return;
    }

    setSendState("sending");
    setSendMessage("");

    try {
      const response = await fetch(
        `http://127.0.0.1:${reviewControlPort}/control/fix-prompt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(reviewControlToken
              ? { "X-OpenReview-Control-Token": reviewControlToken }
              : {}),
          },
          body: JSON.stringify({ prompt }),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload?.error ??
            `Fix handoff failed with status ${response.status}.`,
        );
      }
      setSendState("sent");
      setSendMessage("OpenCode opened on the far right with this prompt.");
    } catch (error) {
      setSendState("error");
      setSendMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return html`
    <div
      className=${`issue-fixer-action-card interface-prompt-card ${initiallyExpanded ? "interface-prompt-card-active" : ""}`}
    >
      <p className="inspector-kicker">Recommended interface change</p>
      <p className="inspector-copy issue-fixer-copy">
        <strong>${issue.functionName || issue.title}</strong>
      </p>
      <p className="inspector-copy inspector-copy-secondary">
        ${issue.problem || issue.detail || getInterfaceSuggestion(issue)}
      </p>
      ${isCombineOpportunity(issue)
        ? html`<div className="inspector-pill-grid">
            <span className="inspector-pill"
              >Strategy:
              ${getSimplificationStrategyLabel(
                issue.simplificationStrategy,
              )}</span
            >
            ${issue.combineWith?.map(
              (entry) =>
                html`<span key=${entry} className="inspector-pill"
                  >${entry}</span
                >`,
            )}
          </div>`
        : null}
      ${renderInterfaceChangePreview(issue, {
        compact: true,
        afterLabel: "After (recommended)",
      })}
      ${issue.whyBetter
        ? html`<p className="interface-change-explainer">
            <strong>Why this is better:</strong> ${issue.whyBetter}
          </p>`
        : null}
      <label className="issue-fixer-label">Edit improvement prompt</label>
      <textarea
        className="issue-fixer-textarea"
        value=${prompt}
        onInput=${(event) => setPrompt(event.currentTarget.value)}
        rows=${3}
      ></textarea>
      <div className="inspector-action-row">
        <button
          className="btn-fix-primary"
          onClick=${handleFix}
          disabled=${sendState === "sending"}
        >
          ${sendState === "sending" ? "Sending…" : "Fix in OpenCode"}
        </button>
        <button className="inspector-inline-action" onClick=${handleCopy}>
          ${copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <p className="issue-fixer-note">
        ${sendMessage ||
        "Fix in OpenCode opens a dedicated pane with the suggested interface change."}
      </p>
    </div>
  `;
}

function OverviewReviewPanel({
  changedLayers,
  graphSummary,
  reviewDiff,
  findings,
  changedPaths,
  onSelectNode,
  onSelectIssue,
}) {
  const changedPathSet = useMemo(
    () =>
      new Set(
        (changedPaths ?? []).map((entry) => normalizeFileReference(entry)).filter(Boolean),
      ),
    [changedPaths],
  );
  const importantFindings = useMemo(() => {
    const severityRank = { risk: 0, warning: 1, info: 2 };
    const rankedFindings = findings
      .filter(
        (finding) =>
          finding.category === "interface" &&
          (isCombineOpportunity(finding) ||
            Boolean(finding.functionName) ||
            Boolean(finding.better) ||
            Boolean(finding.current)),
      )
      .sort((left, right) => {
        const leftCombineRank = isCombineOpportunity(left) ? 0 : 1;
        const rightCombineRank = isCombineOpportunity(right) ? 0 : 1;
        if (leftCombineRank !== rightCombineRank) {
          return leftCombineRank - rightCombineRank;
        }

        const leftSeverity = severityRank[left.severity] ?? 3;
        const rightSeverity = severityRank[right.severity] ?? 3;
        if (leftSeverity !== rightSeverity) {
          return leftSeverity - rightSeverity;
        }

        return String(
          left.functionName || left.title || left.path || "",
        ).localeCompare(
          String(right.functionName || right.title || right.path || ""),
        );
      });
    const adjacentFindings = rankedFindings.filter((finding) => {
      const findingPath = normalizeFileReference(
        finding.path ?? finding.contract?.path ?? "",
      );
      return findingPath && changedPathSet.has(findingPath);
    });

    return (adjacentFindings.length ? adjacentFindings : rankedFindings).slice(
      0,
      6,
    );
  }, [changedPathSet, findings]);
  return html`
    <div>
      <div className="inspector-section">
        <p className="inspector-kicker">Top improvements to make</p>
        ${importantFindings.length
          ? html`<${FindingsList}
              findings=${importantFindings}
              onSelectIssue=${onSelectIssue}
            />`
          : html`<p className="inspector-copy inspector-copy-secondary">
              No interface simplifications surfaced for this view yet.
            </p>`}
      </div>
    </div>
  `;
}

function GroupDetailsPanel({
  node,
  graphDocument,
  fileByNodeId,
  reviewDiff,
  findings,
  onSelectNode,
  onSelectIssue,
  onResetScope,
}) {
  const children = (graphDocument?.nodes ?? []).filter(
    (candidate) => candidate.parentId === node.id,
  );
  const visibleChildren = children.filter(
    (candidate) =>
      candidate.state === "changed" ||
      candidate.state === "affected" ||
      candidate.type === "group",
  );
  const hiddenCount = Math.max(0, children.length - visibleChildren.length);
  const changedFiles = children.filter(
    (candidate) => candidate.state === "changed",
  );
  const affectedFiles = children.filter(
    (candidate) => candidate.state === "affected",
  );
  const areaDiffItems = (reviewDiff?.files ?? [])
    .filter(
      (item) =>
        item.area === node.label ||
        item.path.startsWith(`${node.path}/`) ||
        item.path === node.path,
    )
    .slice(0, 8);

  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">
            ${changedFiles.length} modified
            components${affectedFiles.length
              ? ` and ${affectedFiles.length} impacted dependencies`
              : ""}
            belong to this subsystem boundary.
          </p>
          <p className="inspector-copy inspector-copy-secondary">
            Inspect this area for interface drift, dependency direction leaks,
            and change amplification.
          </p>
        </div>
        <button className="inspector-inline-action" onClick=${onResetScope}>
          Reset view
        </button>
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Boundary findings</p>
        <${FindingsList} findings=${findings} onSelectIssue=${onSelectIssue} />
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Visible surfaces</p>
        <div className="inspector-pill-grid">
          ${visibleChildren
            .slice(0, 6)
            .map(
              (child) =>
                html`<${InspectorPill}
                  key=${child.id}
                  label=${child.label}
                  onClick=${() => onSelectNode(child)}
                />`,
            )}
        </div>
        ${hiddenCount
          ? html`<p className="inspector-copy inspector-copy-secondary">
              + ${hiddenCount} deeper implementation files are hidden.
            </p>`
          : null}
      </div>
    </div>
  `;
}

function FileDetailsPanel({
  node,
  insight,
  reviewDiffFile,
  findings,
  onSelectIssue,
}) {
  const normalizedInsight = normalizeInsight(insight);
  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">
            ${normalizedInsight?.branchChange ??
            normalizedInsight?.interfaceSummary ??
            "This file participates in the currently selected interface review."}
          </p>
        </div>
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Boundary findings</p>
        <${FindingsList} findings=${findings} onSelectIssue=${onSelectIssue} />
      </div>
      ${normalizedInsight?.callerImpact
        ? html`<p className="inspector-copy inspector-copy-secondary">
            ${normalizedInsight.callerImpact}
          </p>`
        : null}
    </div>
  `;
}

function RepoPartDetailsPanel({
  node,
  findings,
  changedFiles,
  changedInterfaces,
  selectedIssue,
  reviewControlPort,
  reviewControlToken,
  onSelectIssue,
}) {
  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">
            ${node.description ??
            "This repo part defines a boundary or shared interface in the current change."}
          </p>
        </div>
      </div>
      ${changedInterfaces.length
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Improvements by interface method</p>
            <div className="inspector-list inspector-list-compact">
              ${changedInterfaces.map((item) => {
                const matchingFindings = getFindingsForInterfaceItem({
                  item,
                  findings,
                });
                return html`<div
                  key=${`${item.path}:${item.name}`}
                  className="inspector-list-item static interface-improvement-card"
                >
                  <div>
                    <strong>${item.name}</strong>
                    <span className="inspector-copy inspector-copy-secondary"
                      >${item.path}</span
                    >
                    ${getCollapsedAliasPaths(item).length
                      ? html`<span
                          className="inspector-copy inspector-copy-secondary"
                          >Source of truth · ${item.sourceOfTruthPath}</span
                        >`
                      : null}
                    <span className="inspector-copy inspector-copy-secondary"
                      >${item.consumerParts.length
                        ? `${item.consumerParts.join(", ")} consume this`
                        : "No external consumers detected"}</span
                    >
                    <${InterfaceSuggestionCard}
                      title=${item.name}
                      path=${item.path}
                      consumerLabel=${item.consumerParts.length
                        ? `${item.consumerParts.length} consumers affected`
                        : ""}
                      current=${matchingFindings[0]?.current ||
                      item.currentDeclaration ||
                      item.previewSnippet ||
                      item.declaration}
                      suggestions=${matchingFindings[0]?.suggestions ?? []}
                    />
                    <div
                      className="inspector-pill-grid inspector-pill-grid-compact"
                    >
                      ${matchingFindings.length
                        ? matchingFindings.map(
                            (finding) =>
                              html`<button
                                key=${finding.id}
                                className="inspector-inline-action"
                                onClick=${() => onSelectIssue?.(finding)}
                              >
                                ${finding.title}
                              </button>`,
                          )
                        : html`<div className="inspector-inline-chip">
                            No direct improvement mapped yet
                          </div>`}
                    </div>
                    ${matchingFindings.length
                      ? html`<div className="interface-prompt-stack">
                          ${matchingFindings.map(
                            (finding) =>
                              html`<${PromptSuggestionCard}
                                key=${finding.id}
                                issue=${finding}
                                reviewControlPort=${reviewControlPort}
                                reviewControlToken=${reviewControlToken}
                                initiallyExpanded=${selectedIssue?.id ===
                                finding.id}
                              />`,
                          )}
                        </div>`
                      : null}
                  </div>
                </div>`;
              })}
            </div>
          </div>`
        : null}
      ${findings.length
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Section-level improvements</p>
            <${FindingsList}
              findings=${findings}
              onSelectIssue=${onSelectIssue}
            />
          </div>`
        : null}
      ${changedFiles.length
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Changed evidence</p>
            <div className="inspector-list inspector-list-compact">
              ${changedFiles.slice(0, 6).map(
                (file) =>
                  html`<div
                    key=${file.path}
                    className="inspector-list-item static"
                  >
                    <span>${file.path}</span>
                    <span className="inspector-list-meta"
                      >${file.status} ·
                      +${file.insertions}/-${file.deletions}</span
                    >
                  </div>`,
              )}
            </div>
          </div>`
        : null}
    </div>
  `;
}

function InterfaceDetailsPanel({
  node,
  interfaceItem,
  findings,
  onSelectIssue,
  worktreePath,
}) {
  const primaryFinding = findings[0] ?? null;
  const codeLocation = parseCodeLocation(
    primaryFinding?.location ?? "",
    worktreePath,
  );
  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">${interfaceItem.declaration}</p>
          <p className="inspector-copy inspector-copy-secondary">
            ${interfaceItem.path}
          </p>
          ${codeLocation
            ? html`<p className="inspector-copy inspector-copy-secondary">
                Defined at
                <a href=${codeLocation.cursorUrl}>${codeLocation.label}</a>
              </p>`
            : null}
        </div>
      </div>
      ${renderSourceOfTruthMeta(interfaceItem)}
      <div className="inspector-section">
        <p className="inspector-kicker">Consumers</p>
        <div className="inspector-list inspector-list-compact">
          ${interfaceItem.consumers.length
            ? interfaceItem.consumers.map(
                (consumer) =>
                  html`<div
                    key=${consumer.path}
                    className="inspector-list-item static"
                  >
                    <span>
                      <strong>${consumer.path.split("/").slice(-1)[0]}</strong>
                      <span className="inspector-copy inspector-copy-secondary"
                        >${consumer.path}</span
                      >
                      <span className="inspector-copy inspector-copy-secondary"
                        >${consumer.preview}</span
                      >
                    </span>
                  </div>`,
              )
            : html`<div className="inspector-list-item static muted">
                <span>No external consumers detected.</span>
              </div>`}
        </div>
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">
          Current interface and better interface
        </p>
        <${InterfaceSuggestionCard}
          title=${interfaceItem.name}
          path=${codeLocation?.label ?? interfaceItem.path}
          consumerLabel=${interfaceItem.consumerParts?.length
            ? `${interfaceItem.consumerParts.length} consumers affected`
            : ""}
          current=${primaryFinding?.current ||
          interfaceItem.currentDeclaration ||
          interfaceItem.previewSnippet ||
          interfaceItem.snippet ||
          interfaceItem.declaration}
          suggestions=${primaryFinding?.suggestions ?? []}
        />
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Suggested improvements</p>
        ${primaryFinding?.better
          ? html`<p className="inspector-copy">
              <strong>Suggested interface:</strong> ${primaryFinding.better}
            </p>`
          : null}
        ${primaryFinding?.whyBetter
          ? html`<p className="inspector-copy inspector-copy-secondary">
              ${primaryFinding.whyBetter}
            </p>`
          : null}
        <${FindingsList} findings=${findings} onSelectIssue=${onSelectIssue} />
      </div>
    </div>
  `;
}

function OverviewGraphPage({
  payload,
  reexamineState,
  reexamineMessage,
  onQueueReexamine,
  onReexamineError,
  debugOpen,
  onToggleDebug,
}) {
  const graphDocument = payload.graphDocument;
  const rawFileInsights = payload.fileInsightsIndex?.files ?? {};
  const allLogicalPaths = useMemo(
    () =>
      buildLogicalPathSet({
        fileInsights: rawFileInsights,
        changedInterfaces: payload.changedInterfaces ?? [],
        graphDocument,
      }),
    [graphDocument, payload.changedInterfaces, rawFileInsights],
  );
  const fileInsights = useMemo(
    () => normalizeFileInsightsIndex(rawFileInsights, allLogicalPaths),
    [allLogicalPaths, rawFileInsights],
  );
  const reviewDiff = payload.reviewDiff ?? { baseLabel: "", files: [] };
  const reviewIssues = useMemo(
    () =>
      Object.values(fileInsights).flatMap((insight) =>
        buildFindingsFromInsight({
          insight,
          nodeLabel: insight?.basename ?? insight?.path ?? "file",
        }),
      ),
    [fileInsights],
  );
  const changedInterfaces = useMemo(
    () =>
      normalizeChangedInterfaces(
        payload.changedInterfaces ?? [],
        allLogicalPaths,
      ),
    [allLogicalPaths, payload.changedInterfaces],
  );
  const allNodes = graphDocument?.nodes ?? [];
  const nodesById = useMemo(
    () => Object.fromEntries(allNodes.map((node) => [node.id, node])),
    [allNodes],
  );
  const parentById = useMemo(
    () => Object.fromEntries(allNodes.map((node) => [node.id, node.parentId])),
    [allNodes],
  );
  const childrenByParentId = useMemo(
    () =>
      allNodes.reduce((acc, node) => {
        if (!node.parentId) {
          return acc;
        }
        if (!acc[node.parentId]) {
          acc[node.parentId] = [];
        }
        acc[node.parentId].push(node);
        return acc;
      }, {}),
    [allNodes],
  );
  const ancestorIdsByNodeId = useMemo(() => {
    const cache = {};
    const resolve = (nodeId) => {
      if (cache[nodeId]) {
        return cache[nodeId];
      }

      const ancestry = [];
      let cursor = parentById[nodeId] ?? null;
      while (cursor) {
        ancestry.push(cursor);
        cursor = parentById[cursor] ?? null;
      }

      cache[nodeId] = ancestry;
      return ancestry;
    };

    return Object.fromEntries(
      allNodes.map((node) => [node.id, resolve(node.id)]),
    );
  }, [allNodes, parentById]);
  const descendantIdsByNodeId = useMemo(() => {
    const cache = {};
    const resolve = (nodeId) => {
      if (cache[nodeId]) {
        return cache[nodeId];
      }

      const descendants = [];
      const stack = [...(childrenByParentId[nodeId] ?? [])];
      while (stack.length) {
        const current = stack.pop();
        if (!current) {
          continue;
        }
        descendants.push(current.id);
        stack.push(...(childrenByParentId[current.id] ?? []));
      }

      cache[nodeId] = descendants;
      return descendants;
    };

    return Object.fromEntries(
      allNodes.map((node) => [node.id, resolve(node.id)]),
    );
  }, [allNodes, childrenByParentId]);
  const hiddenTopLayerIds = useMemo(
    () =>
      new Set(
        allNodes
          .filter((node) => node.type === "group" && !node.parentId)
          .map((node) => node.id),
      ),
    [allNodes],
  );
  const touchedLayerIds = useMemo(() => {
    const nodesById = Object.fromEntries(
      allNodes.map((node) => [node.id, node]),
    );
    const next = new Set();

    allNodes.forEach((node) => {
      if (node.state !== "changed" && node.state !== "affected") {
        return;
      }

      let cursor = node.parentId;
      while (cursor) {
        next.add(cursor);
        cursor = nodesById[cursor]?.parentId ?? null;
      }
    });

    return next;
  }, [allNodes]);
  const changedLayers = useMemo(
    () =>
      allNodes.filter(
        (node) =>
          hiddenTopLayerIds.has(node.id) && touchedLayerIds.has(node.id),
      ),
    [allNodes, hiddenTopLayerIds, touchedLayerIds],
  );
  const fileByNodeId = useMemo(
    () =>
      Object.fromEntries(
        Object.values(fileInsights).map((file) => [`file:${file.path}`, file]),
      ),
    [fileInsights],
  );
  const nodeRoleById = useMemo(
    () =>
      Object.fromEntries(
        allNodes.map((node) => [
          node.id,
          getArchitectureRole(node, fileByNodeId[node.id] ?? null),
        ]),
      ),
    [allNodes, fileByNodeId],
  );
  const [expandedGroupIds, setExpandedGroupIds] = useState(
    () => new Set(changedLayers.map((node) => node.id)),
  );
  const [selectedPath, setSelectedPath] = useState(null);
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [activeIssueId, setActiveIssueId] = useState(null);
  const [fixPrompt, setFixPrompt] = useState("");
  const [zoom, setZoom] = useState(0.82);
  const inspector = useResizablePanel({
    storageKey: INSPECTOR_WIDTH_KEY,
    defaultWidth: DEFAULT_INSPECTOR_WIDTH,
    direction: "right",
  });
  const branchName =
    reviewDiff.currentBranch ??
    (() => {
      const segments = String(payload.worktreePath ?? "")
        .split("/")
        .filter(Boolean);
      return segments[segments.length - 1] ?? "local-branch";
    })();
  const reviewControlPort = payload?.sessionDebug?.viewer?.controlPort ?? null;
  const reviewControlToken =
    payload?.sessionDebug?.viewer?.controlToken ?? null;
  const [fetchedBranches, setFetchedBranches] = useState([]);
  const [fetchedCurrentBranch, setFetchedCurrentBranch] = useState(null);
  const [compareOptionsLoading, setCompareOptionsLoading] = useState(
    typeof reviewControlPort === "number" && reviewControlPort > 0,
  );
  useEffect(() => {
    if (!(typeof reviewControlPort === "number" && reviewControlPort > 0)) {
      setFetchedBranches([]);
      setFetchedCurrentBranch(null);
      setCompareOptionsLoading(false);
      return undefined;
    }

    const abortController = new AbortController();
    setCompareOptionsLoading(true);

    void (async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${reviewControlPort}/control/git-branches`,
          { signal: abortController.signal },
        );
        if (!response.ok) {
          throw new Error(
            `Branch fetch failed with status ${response.status}.`,
          );
        }

        const nextPayload = await response.json();
        setFetchedBranches(
          Array.isArray(nextPayload?.branches)
            ? nextPayload.branches
                .map((branch) => String(branch ?? "").trim())
                .filter(Boolean)
            : [],
        );
        setFetchedCurrentBranch(
          typeof nextPayload?.currentBranch === "string" &&
            nextPayload.currentBranch.trim()
            ? nextPayload.currentBranch.trim()
            : null,
        );
      } catch (error) {
        if (error?.name !== "AbortError") {
          setFetchedBranches([]);
          setFetchedCurrentBranch(null);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setCompareOptionsLoading(false);
        }
      }
    })();

    return () => abortController.abort();
  }, [reviewControlPort]);
  const currentBranchName = fetchedCurrentBranch || branchName;
  const compareOptions = useMemo(
    () =>
      getAvailableCompareBranches({
        reviewDiff,
        currentBranch: currentBranchName,
        fetchedBranches,
      }),
    [currentBranchName, fetchedBranches, reviewDiff],
  );
  const [compareBranch, setCompareBranch] = useState(
    getPreferredCompareBranch(compareOptions, reviewDiff.baseLabel ?? ""),
  );
  useEffect(() => {
    const preferredBranch = getPreferredCompareBranch(
      compareOptions,
      reviewDiff.baseLabel ?? "",
    );

    if (
      (!compareBranch || !compareOptions.includes(compareBranch)) &&
      preferredBranch
    ) {
      setCompareBranch(preferredBranch);
    }
  }, [compareBranch, compareOptions, reviewDiff.baseLabel]);
  const activeComparison = useMemo(
    () =>
      reviewDiff.comparisons?.[compareBranch] ?? {
        files: reviewDiff.files ?? [],
        mergeBase: reviewDiff.mergeBase ?? null,
      },
    [
      compareBranch,
      reviewDiff.comparisons,
      reviewDiff.files,
      reviewDiff.mergeBase,
    ],
  );
  const interfaceGraph = useMemo(() => {
    if (changedInterfaces.length) {
      const nodes = [];
      const edges = [];
      const findingsByNodeId = {};
      const filesByNodeId = {};
      const primaryPathByNodeId = {};
      const summaryByNodeId = {};

      const groupedInterfaces = Array.from(
        changedInterfaces.slice(0, 12).reduce((map, item) => {
          const existing = map.get(item.path) ?? [];
          existing.push(item);
          map.set(item.path, existing);
          return map;
        }, new Map()),
      );
      let currentY = 56;

      groupedInterfaces.forEach(([groupPath, items]) => {
        const providerPartId =
          getPrimaryRepoPartIdForPath(groupPath) ??
          `part:${items[0]?.part ?? "shared"}`;
        const providerNodeId = `provider:${groupPath}`;
        const relatedFiles = (activeComparison.files ?? []).filter(
          (file) => file.path === groupPath,
        );
        const providerFindings = reviewIssues
          .filter((issue) => issue.path === groupPath)
          .map((issue) => ({ ...issue, nodeId: providerNodeId }));
        const groupHeight = Math.max(140, items.length * 116);

        nodes.push({
          id: providerNodeId,
          type: "group",
          nodeKind: "provider",
          partId: providerPartId,
          role: "boundary",
          label: groupPath,
          path: groupPath,
          description: `Defines ${items.length} shared function${items.length === 1 ? "" : "s"}`,
          summary: `${items.length} changed function${items.length === 1 ? "" : "s"}`,
          state: "changed",
          position: {
            x: 56,
            y: currentY + Math.max(0, (groupHeight - 62) / 2),
          },
          size: { width: 300, height: 62 },
        });

        findingsByNodeId[providerNodeId] = providerFindings;
        filesByNodeId[providerNodeId] = relatedFiles;
        primaryPathByNodeId[providerNodeId] = groupPath;
        summaryByNodeId[providerNodeId] =
          `${items.length} changed function${items.length === 1 ? "" : "s"}`;

        items.forEach((item, interfaceIndex) => {
          const interfaceY = currentY + interfaceIndex * 116;
          const interfaceNodeId = `interface:${item.path}:${item.name}`;
          const relatedFindings = reviewIssues
            .filter(
              (issue) =>
                issue.path === item.path &&
                (!issue.functionName || issue.functionName === item.name),
            )
            .map((issue) => ({ ...issue, nodeId: interfaceNodeId }));

          nodes.push({
            id: interfaceNodeId,
            type: "group",
            nodeKind: "interface",
            role: "interface",
            label: item.name,
            path: item.path,
            declaration: item.declaration,
            snippet: item.snippet,
            description: item.declaration,
            summary: item.path,
            state: "changed",
            position: { x: 404, y: interfaceY },
            size: { width: 360, height: 86 },
          });

          edges.push({
            id: `edge:${providerNodeId}:${interfaceNodeId}`,
            source: providerNodeId,
            target: interfaceNodeId,
            type: "structure",
            label: "defines",
          });

          findingsByNodeId[interfaceNodeId] = relatedFindings;
          filesByNodeId[interfaceNodeId] = relatedFiles;
          primaryPathByNodeId[interfaceNodeId] = item.path;
          summaryByNodeId[interfaceNodeId] = item.path;

          item.consumers.slice(0, 3).forEach((consumer, consumerIndex) => {
            const consumerNodeId = `consumer:${item.path}:${item.name}:${consumer.path}`;
            nodes.push({
              id: consumerNodeId,
              type: "group",
              nodeKind: "consumer",
              partId:
                REPO_PART_IDS_BY_LABEL[String(consumer.part).toLowerCase()] ??
                null,
              role: "adapter",
              label: consumer.path,
              path: consumer.path,
              description: consumer.preview,
              summary: consumer.preview,
              state: "affected",
              position: { x: 850, y: interfaceY + consumerIndex * 56 },
              size: { width: 320, height: 54 },
            });
            edges.push({
              id: `edge:${interfaceNodeId}:${consumerNodeId}`,
              source: interfaceNodeId,
              target: consumerNodeId,
              type: "impact",
              label: "consumed by",
            });
            findingsByNodeId[consumerNodeId] = relatedFindings;
            filesByNodeId[consumerNodeId] = [];
            primaryPathByNodeId[consumerNodeId] = consumer.path;
            summaryByNodeId[consumerNodeId] = consumer.preview;
          });
        });

        currentY += groupHeight + 40;
      });

      return {
        nodes: Array.from(
          new Map(nodes.map((node) => [node.id, node])).values(),
        ),
        edges: Array.from(
          new Map(edges.map((edge) => [edge.id, edge])).values(),
        ),
        filesByPartId: {},
        findingsByPartId: {},
        findingsByNodeId,
        filesByNodeId,
        primaryPathByPartId: {},
        primaryPathByNodeId,
        summaryByPartId: {},
        summaryByNodeId,
      };
    }

    const normalizedComparisonFiles = (activeComparison.files ?? []).map(
      (file) => ({
        ...file,
        logicalPath: getLogicalPath(file.path, allLogicalPaths),
      }),
    );
    const filesByNodeId = {};
    const findingsByNodeId = {};
    const primaryPathByNodeId = {};
    const summaryByNodeId = {};

    const nodes = allNodes.map((node) => {
      const nodePath = getLogicalPath(node.path ?? "", allLogicalPaths);
      const pathPrefix =
        node.type === "group" && nodePath
          ? `${nodePath.replace(/\/$/u, "")}/`
          : null;
      const matchedFiles = normalizedComparisonFiles.filter((file) => {
        if (!nodePath) {
          return false;
        }

        return (
          file.logicalPath === nodePath ||
          (pathPrefix ? file.logicalPath.startsWith(pathPrefix) : false)
        );
      });
      const matchedFindings = reviewIssues
        .filter((issue) => {
          const issuePath = getLogicalPath(issue.path ?? "", allLogicalPaths);
          if (!nodePath || !issuePath) {
            return false;
          }

          return (
            issuePath === nodePath ||
            (pathPrefix ? issuePath.startsWith(pathPrefix) : false)
          );
        })
        .map((issue) => ({ ...issue, nodeId: node.id }));
      const changedCount = matchedFiles.filter(
        (file) =>
          file.status === "modified" ||
          file.status === "added" ||
          file.status === "deleted" ||
          file.status === "renamed" ||
          file.status === "untracked",
      ).length;
      const affectedCount = matchedFiles.length - changedCount;
      const summary =
        [
          changedCount ? `${changedCount} changed` : "",
          affectedCount ? `${affectedCount} affected` : "",
          matchedFindings.length ? `${matchedFindings.length} findings` : "",
        ]
          .filter(Boolean)
          .join(" · ") ||
        node.architecturalArea ||
        node.description ||
        node.path ||
        node.label;

      filesByNodeId[node.id] = matchedFiles;
      findingsByNodeId[node.id] = matchedFindings;
      primaryPathByNodeId[node.id] =
        matchedFiles[0]?.path ?? (node.type === "file" ? node.path : null);
      summaryByNodeId[node.id] = summary;

      return {
        ...node,
        summary,
      };
    });

    return {
      nodes,
      edges: (graphDocument?.edges ?? []).map((edge) => ({
        ...edge,
        reasons: edge.reasons ?? (edge.label ? [edge.label] : []),
      })),
      filesByPartId: filesByNodeId,
      findingsByPartId: findingsByNodeId,
      findingsByNodeId,
      filesByNodeId,
      primaryPathByPartId: primaryPathByNodeId,
      primaryPathByNodeId,
      summaryByPartId: summaryByNodeId,
      summaryByNodeId,
    };
  }, [
    activeComparison.files,
    allNodes,
    allLogicalPaths,
    changedInterfaces,
    graphDocument,
    reviewIssues,
  ]);
  const changedInterfacesByPartId = useMemo(
    () =>
      changedInterfaces.reduce((acc, item) => {
        const relatedPartIds = new Set();
        const providerPartId = getPrimaryRepoPartIdForPath(item.path);
        if (providerPartId) {
          relatedPartIds.add(providerPartId);
        }
        for (const consumerPart of item.consumerParts ?? []) {
          const consumerPartId =
            REPO_PART_IDS_BY_LABEL[String(consumerPart).toLowerCase()] ?? null;
          if (consumerPartId) {
            relatedPartIds.add(consumerPartId);
          }
        }
        for (const partId of relatedPartIds) {
          if (!acc[partId]) {
            acc[partId] = [];
          }
          if (
            !acc[partId].some(
              (candidate) =>
                candidate.path === item.path && candidate.name === item.name,
            )
          ) {
            acc[partId].push(item);
          }
        }
        return acc;
      }, {}),
    [changedInterfaces],
  );
  const issuesByNodeId = useMemo(() => {
    const grouped = {};
    for (const [nodeId, findings] of Object.entries(
      interfaceGraph.findingsByNodeId ?? {},
    )) {
      grouped[nodeId] = findings;
    }
    return grouped;
  }, [interfaceGraph.findingsByNodeId]);
  const activeIssue = useMemo(() => {
    if (!activeIssueId) {
      return null;
    }
    return (
      Object.values(interfaceGraph.findingsByNodeId ?? {})
        .flat()
        .find((issue) => issue.id === activeIssueId) ?? null
    );
  }, [activeIssueId, interfaceGraph.findingsByNodeId, reviewIssues]);
  useEffect(() => {
    if (!activeIssue) {
      return;
    }

    setFixPrompt(activeIssue.fixPrompt ?? "");
  }, [activeIssue?.id]);
  const resolveIssueNodeId = (issue) => {
    if (!issue) {
      return null;
    }

    if (issue.contract?.path && issue.contract?.name) {
      const interfaceNodeId = `interface:${issue.contract.path}:${issue.contract.name}`;
      if (interfaceGraph.nodes.some((node) => node.id === interfaceNodeId)) {
        return interfaceNodeId;
      }
      const providerNodeId = `provider:${issue.contract.path}:${issue.contract.name}`;
      if (interfaceGraph.nodes.some((node) => node.id === providerNodeId)) {
        return providerNodeId;
      }
    }

    return (
      issue.nodeId ??
      getPrimaryRepoPartIdForPath(issue.contract?.path ?? issue.path)
    );
  };
  const activeIssueDiffFile = useMemo(
    () =>
      activeIssue
        ? ((activeComparison.files ?? []).find(
            (item) =>
              item.nodeId === activeIssue.nodeId ||
              item.path === (activeIssue.contract?.path ?? activeIssue.path),
          ) ?? null)
        : null,
    [activeComparison.files, activeIssue],
  );
  const activeIssueRelatedFiles = useMemo(() => {
    if (!activeIssue) {
      return [];
    }

    const activeIssuePath = activeIssue.contract?.path ?? activeIssue.path;

    return (activeComparison.files ?? [])
      .filter((file) => file.path !== activeIssuePath)
      .filter(
        (file) =>
          file.area === activeIssue.area ||
          file.path.split("/").slice(0, -1).join("/") ===
            activeIssuePath.split("/").slice(0, -1).join("/"),
      )
      .slice(0, 3);
  }, [activeComparison.files, activeIssue]);
  const activeIssueNodeIds = useMemo(() => {
    const next = new Set();
    const activeNodeId = resolveIssueNodeId(activeIssue);
    if (!activeNodeId) {
      return next;
    }

    next.add(activeNodeId);
    return next;
  }, [activeIssue, interfaceGraph.nodes]);
  const activeIssueEdgeIds = useMemo(() => {
    if (!interfaceGraph.edges.length || !activeIssueNodeIds.size) {
      return new Set();
    }

    return new Set(
      interfaceGraph.edges
        .filter(
          (edge) =>
            activeIssueNodeIds.has(edge.source) &&
            activeIssueNodeIds.has(edge.target),
        )
        .map((edge) => edge.id),
    );
  }, [activeIssueNodeIds, interfaceGraph.edges]);
  const focusedConnection = useMemo(() => {
    const nextNodeIds = new Set();
    const nextEdgeIds = new Set();
    if (
      !focusedNodeId ||
      activeIssueNodeIds.size > 0 ||
      !interfaceGraph.edges.length
    ) {
      return { nodeIds: nextNodeIds, edgeIds: nextEdgeIds };
    }

    nextNodeIds.add(focusedNodeId);

    for (const edge of interfaceGraph.edges) {
      if (edge.source === focusedNodeId || edge.target === focusedNodeId) {
        nextEdgeIds.add(edge.id);
        nextNodeIds.add(edge.source);
        nextNodeIds.add(edge.target);
      }
    }

    return { nodeIds: nextNodeIds, edgeIds: nextEdgeIds };
  }, [activeIssueNodeIds.size, focusedNodeId, interfaceGraph.edges]);
  const emphasizedNodeIds =
    activeIssueNodeIds.size > 0
      ? activeIssueNodeIds
      : focusedConnection.nodeIds;
  const emphasizedEdgeIds =
    activeIssueNodeIds.size > 0
      ? activeIssueEdgeIds
      : focusedConnection.edgeIds;
  const hasGraphEmphasis =
    emphasizedNodeIds.size > 0 || emphasizedEdgeIds.size > 0;
  const groupContextById = useMemo(() => {
    return interfaceGraph.summaryByNodeId;
  }, [interfaceGraph.summaryByNodeId]);

  useEffect(() => {
    if (!activeIssue) {
      setFixPrompt("");
      return;
    }

    setFixPrompt(activeIssue.fixPrompt ?? "");
  }, [activeIssue]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedPath(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const layout = useMemo(() => {
    const visibleNodes = interfaceGraph.nodes;
    const positions = Object.fromEntries(
      visibleNodes.map((node, index) => [
        node.id,
        node.position ??
          REPO_PART_POSITIONS[node.id] ?? {
            x: 60 + (index % 4) * 320,
            y: 60 + Math.floor(index / 4) * 140,
          },
      ]),
    );
    const sizes = Object.fromEntries(
      visibleNodes.map((node) => [
        node.id,
        node.size ?? { width: 272, height: 86 },
      ]),
    );
    return {
      visibleNodes,
      edges: interfaceGraph.edges,
      positions,
      sizes,
      width: 1360,
      height: 760,
      breadcrumbs:
        focusedNodeId && REPO_PARTS_BY_ID[focusedNodeId]
          ? [
              {
                id: focusedNodeId,
                label: REPO_PARTS_BY_ID[focusedNodeId].label,
              },
            ]
          : [],
    };
  }, [focusedNodeId, interfaceGraph.edges, interfaceGraph.nodes]);

  const selectedInsight = selectedPath
    ? (fileInsights[selectedPath] ?? null)
    : null;
  const focusedNode = focusedNodeId
    ? (interfaceGraph.nodes.find((node) => node.id === focusedNodeId) ?? null)
    : null;
  const focusedPartId = focusedNode?.partId ?? focusedNode?.id ?? null;
  const graphSummary = useMemo(() => {
    const files = changedInterfaces.length
      ? changedInterfaces
      : (activeComparison.files ?? []);
    return {
      changed: files.length,
      affected: changedInterfaces.length
        ? changedInterfaces.reduce(
            (sum, item) => sum + item.consumers.length,
            0,
          )
        : reviewIssues.length,
      context: 0,
      groups: interfaceGraph.nodes.length,
    };
  }, [
    activeComparison.files,
    changedInterfaces,
    interfaceGraph.nodes.length,
    reviewIssues.length,
  ]);
  const architectureSummary = useMemo(
    () => summarizeArchitectureIssues(reviewIssues),
    [reviewIssues],
  );
  const handleReexamine = async () => {
    if (!(typeof reviewControlPort === "number" && reviewControlPort > 0)) {
      onReexamineError(
        "Reexamine needs the viewer service. Start or refresh OpenReview, then try again.",
      );
      return;
    }

    onQueueReexamine({
      compareBranch: compareBranch || null,
      generatedAt: payload.generatedAt ?? null,
      message:
      compareBranch
        ? `Reprocessing in the background against ${compareBranch}.`
        : "Reprocessing in the background.",
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${reviewControlPort}/control/reexamine`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(reviewControlToken
              ? { "X-OpenReview-Control-Token": reviewControlToken }
              : {}),
          },
          body: JSON.stringify({
            baseBranch: compareBranch || null,
            compareBranch: compareBranch || null,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Reexamine request failed with status ${response.status}.`,
        );
      }
    } catch (error) {
      onReexamineError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleSelectNode = (node) => {
    setActiveIssueId(null);
    setFocusedNodeId(node.id);
    setSelectedPath(interfaceGraph.primaryPathByNodeId[node.id] ?? null);
  };

  const handleSelectIssue = (issue) => {
    setActiveIssueId(issue.id);
    setFixPrompt("");
    const nodeId = resolveIssueNodeId(issue);
    if (nodeId) {
      setFocusedNodeId(nodeId);
      setSelectedPath(
        interfaceGraph.primaryPathByNodeId[nodeId] ??
          issue.contract?.path ??
          issue.path ??
          null,
      );
    }
  };

  const handleResetSelection = () => {
    setActiveIssueId(null);
    setFocusedNodeId(null);
    setSelectedPath(null);
  };

  return html`
    <div className="overview-shell viewer-root">
      <main className="graph-page architecture-canvas-shell">
        <${GitReviewTopbar}
          currentBranch=${currentBranchName}
          compareBranch=${compareBranch}
          compareOptions=${compareOptions}
          setCompareBranch=${setCompareBranch}
          compareOptionsLoading=${compareOptionsLoading}
          graphSummary=${graphSummary}
          worktreePath=${payload.worktreePath}
          reviewControlPort=${reviewControlPort}
          onReexamine=${handleReexamine}
          reexamineState=${reexamineState}
          reexamineMessage=${reexamineMessage}
          debugOpen=${debugOpen}
          onToggleDebug=${onToggleDebug}
        />
        <div className="graph-shell graph-shell-reference">
          ${!layout.visibleNodes.length
            ? html`<div className="graph-empty">
                No architecture graph was generated yet.
              </div>`
            : html` <div
                className="graph-canvas graph-canvas-workspace"
                onClick=${(event) => {
                  const isInteractive = event.target?.closest?.(
                    ".graph-node, .graph-issue-marker",
                  );
                  if (!isInteractive) {
                    handleResetSelection();
                  }
                }}
              >
                <div
                  className=${`graph-stage ${activeIssueNodeIds.size > 0 ? "graph-stage-issue-focus" : ""}`}
                  style=${{
                    width: `${layout.width}px`,
                    height: `${layout.height}px`,
                    transform: `scale(${zoom})`,
                  }}
                >
                  <svg
                    className="graph-svg"
                    width=${layout.width}
                    height=${layout.height}
                  >
                    <defs>
                      <marker
                        id="graph-arrowhead-structure"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6.5"
                        refY="4"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path
                          d="M 0 0 L 8 4 L 0 8 z"
                          fill="rgba(71, 85, 105, 0.84)"
                        ></path>
                      </marker>
                      <marker
                        id="graph-arrowhead-impact"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6.5"
                        refY="4"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path
                          d="M 0 0 L 8 4 L 0 8 z"
                          fill="rgba(96, 165, 250, 0.92)"
                        ></path>
                      </marker>
                      <marker
                        id="graph-arrowhead-active"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6.5"
                        refY="4"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path
                          d="M 0 0 L 8 4 L 0 8 z"
                          fill="rgba(125, 211, 252, 0.98)"
                        ></path>
                      </marker>
                    </defs>
                    ${layout.edges.map((edge) => {
                      const from = layout.positions[edge.source];
                      const to = layout.positions[edge.target];
                      const fromSize = layout.sizes[edge.source];
                      const toSize = layout.sizes[edge.target];
                      if (!from || !to) {
                        return null;
                      }
                      const startX = from.x + (fromSize?.width ?? 180) / 2;
                      const startY = from.y + (fromSize?.height ?? 48);
                      const endX = to.x + (toSize?.width ?? 180) / 2;
                      const endY = to.y;
                      const controlOffset = Math.max(42, (endY - startY) * 0.4);
                      const pathData = `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`;
                      const highlighted = emphasizedEdgeIds.has(edge.id);
                      const dimmed = hasGraphEmphasis && !highlighted;
                      const markerEnd = highlighted
                        ? "url(#graph-arrowhead-active)"
                        : edge.type === "impact"
                          ? "url(#graph-arrowhead-impact)"
                          : "url(#graph-arrowhead-structure)";
                      const label = getArchitectureRoleEdgeLabel(
                        edge,
                        REPO_PARTS_BY_ID[edge.source],
                        REPO_PARTS_BY_ID[edge.target],
                      );
                      const labelWidth = Math.max(
                        54,
                        Math.min(190, label.length * 6.6 + 18),
                      );
                      const labelX = (startX + endX) / 2 - labelWidth / 2;
                      const labelY = (startY + endY) / 2 - 12;
                      return html`
                        <path
                          key=${edge.id}
                          d=${pathData}
                          markerEnd=${markerEnd}
                          className=${`graph-edge ${edge.type === "impact" ? "graph-edge-impact" : "graph-edge-structure"} ${highlighted ? "graph-edge-active-path" : ""} ${dimmed ? "graph-edge-dimmed" : ""}`}
                        ></path>
                        ${true
                          ? html`<g
                              key=${`${edge.id}-label`}
                              className="graph-edge-label-group"
                            >
                              <rect
                                className="graph-edge-label-bg"
                                x=${labelX}
                                y=${labelY}
                                rx="9"
                                ry="9"
                                width=${labelWidth}
                                height="18"
                              ></rect>
                              <text
                                className="graph-edge-label-text"
                                x=${labelX + labelWidth / 2}
                                y=${labelY + 12}
                                >${label}</text
                              >
                            </g>`
                          : null}
                      `;
                    })}
                  </svg>
                  ${layout.visibleNodes.map((node, index) => {
                    const pos = layout.positions[node.id];
                    const insight = interfaceGraph.primaryPathByPartId[node.id]
                      ? (fileInsights[
                          interfaceGraph.primaryPathByPartId[node.id]
                        ] ?? null)
                      : null;
                    const nodeIssues = issuesByNodeId[node.id] ?? [];
                    const visualState = getNodeVisualState(node, insight);
                    const nodeMeta = getNodeDisplayHint({
                      node,
                      insight,
                      issues: nodeIssues,
                      groupContext: groupContextById[node.id] ?? "",
                    });
                    const nodeSuggestion = getNodeSuggestionHint(nodeIssues);
                    const issueSummary = summarizeIssues(nodeIssues);
                    const primaryIssue = issueSummary.primaryIssue;
                    const selected = focusedNodeId === node.id;
                    const pathHighlighted =
                      hasGraphEmphasis && emphasizedNodeIds.has(node.id);
                    const dimmed = hasGraphEmphasis && !pathHighlighted;
                    const showIssueMarker =
                      issueSummary.risk > 0 ||
                      issueSummary.warning > 0 ||
                      focusedNodeId === node.id ||
                      pathHighlighted;
                    return html`<button
                      key=${node.id}
                      className=${`${visualState.className} ${selected ? "graph-node-selected" : ""} ${issueSummary.risk ? "graph-node-has-issues graph-node-issue-severe" : primaryIssue ? "graph-node-has-issues" : ""} ${pathHighlighted ? "graph-node-active-path" : ""} ${dimmed ? "graph-node-dimmed" : ""}`}
                      style=${{
                        left: `${pos.x}px`,
                        top: `${pos.y}px`,
                        width: `${layout.sizes[node.id]?.width ?? 226}px`,
                        minHeight: `${layout.sizes[node.id]?.height ?? 62}px`,
                        "--node-index": index,
                      }}
                      onClick=${() => {
                        if (primaryIssue) {
                          handleSelectIssue(primaryIssue);
                          return;
                        }
                        handleSelectNode(node);
                      }}
                    >
                      <span
                        className=${`graph-node-rail graph-node-rail-${visualState.tone}`}
                      ></span>
                      <span className="node-content">
                        <span className="node-text">
                          <span className="graph-node-label"
                            >${node.label}</span
                          >
                          ${nodeMeta
                            ? html`<span className="graph-node-secondary"
                                >${nodeMeta}</span
                              >`
                            : null}
                          ${nodeSuggestion
                            ? html`<span className="graph-node-secondary"
                                >→ ${nodeSuggestion}</span
                              >`
                            : null}
                        </span>
                      </span>
                      ${primaryIssue && showIssueMarker
                        ? html`<span
                            className=${`graph-issue-marker graph-issue-marker-${primaryIssue.severity} ${pathHighlighted ? "graph-issue-marker-active" : ""}`}
                            title=${getIssueMarkerTitle(issueSummary)}
                            onClick=${(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              handleSelectIssue(primaryIssue);
                            }}
                            role="button"
                            tabIndex=${0}
                            onKeyDown=${(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                event.stopPropagation();
                                handleSelectIssue(primaryIssue);
                              }
                            }}
                          >
                            ${getIssueMarkerLabel(issueSummary)}
                          </span>`
                        : null}
                    </button>`;
                  })}
                </div>
              </div>`}
        </div>
      </main>
      <div
        className="inspector-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review rail"
        onPointerDown=${inspector.onPointerDown}
        onMouseDown=${inspector.onMouseDown}
      >
        <span className="inspector-resize-grip" aria-hidden="true">⋮</span>
      </div>
      <aside
        className="inspector-panel architecture-inspector-panel"
        style=${inspector.panelStyle}
      >
        <div className="inspector-detail-panel">
          ${activeIssue
            ? html`<${IssueFixerPanel}
                issue=${activeIssue}
                fixPrompt=${fixPrompt}
                setFixPrompt=${setFixPrompt}
                compareBranch=${compareBranch}
                currentBranch=${currentBranchName}
                activeComparison=${activeComparison}
                issueDiffFile=${activeIssueDiffFile}
                relatedFiles=${activeIssueRelatedFiles}
                reviewControlPort=${reviewControlPort}
                reviewControlToken=${reviewControlToken}
                onClose=${() => setActiveIssueId(null)}
              />`
            : focusedNode?.nodeKind === "interface"
              ? html`<${InterfaceDetailsPanel}
                  node=${focusedNode}
                  interfaceItem=${changedInterfaces.find(
                    (item) =>
                      item.path === focusedNode.path &&
                      item.name === focusedNode.label,
                  ) ?? null}
                  findings=${issuesByNodeId[focusedNode.id] ?? []}
                  worktreePath=${payload.worktreePath}
                  onSelectIssue=${handleSelectIssue}
                />`
              : focusedNode
                ? html`<${RepoPartDetailsPanel}
                    node=${focusedNode}
                    findings=${issuesByNodeId[focusedPartId] ??
                    issuesByNodeId[focusedNode.id] ??
                    []}
                    changedFiles=${interfaceGraph.filesByPartId[
                      focusedPartId
                    ] ??
                    interfaceGraph.filesByPartId[focusedNode.id] ??
                    []}
                    changedInterfaces=${changedInterfacesByPartId[
                      focusedPartId
                    ] ?? []}
                    selectedIssue=${activeIssue}
                    reviewControlPort=${reviewControlPort}
                    reviewControlToken=${reviewControlToken}
                    onSelectIssue=${handleSelectIssue}
                  />`
                : html`<${OverviewReviewPanel}
                    changedLayers=${layout.visibleNodes}
                    graphSummary=${graphSummary}
                    reviewDiff=${{
                      ...reviewDiff,
                      files: activeComparison.files,
                      baseLabel: compareBranch,
                    }}
                    findings=${Object.values(issuesByNodeId).flat()}
                    changedPaths=${(activeComparison.files ?? []).map(
                      (file) => file.path,
                    )}
                    onSelectNode=${handleSelectNode}
                    onSelectIssue=${handleSelectIssue}
                  />`}
        </div>
      </aside>
    </div>
  `;
}

function ViewerApp({ payload }) {
  const [livePayload, setLivePayload] = useState(payload);
  const [reexamineState, setReexamineState] = useState("idle");
  const [reexamineMessage, setReexamineMessage] = useState("");
  const [pendingReexamine, setPendingReexamine] = useState(null);
  const debugOpen =
    new URL(window.location.href).searchParams.get("debug") === "1";
  const controlPort = livePayload?.sessionDebug?.viewer?.controlPort ?? null;
  const hasRedirectedRef = useRef(false);
  const statusRefreshDelayMs =
    livePayload?.pageType === "status"
      ? typeof livePayload?.autoRefreshMs === "number" &&
        livePayload.autoRefreshMs > 0
        ? livePayload.autoRefreshMs
        : null
      : null;

  const reloadStatusPage = () => {
    window.location.replace(window.location.pathname);
  };

  const reloadCurrentPage = () => {
    window.location.reload();
  };

  const handleQueueReexamine = ({ compareBranch, generatedAt, message }) => {
    setPendingReexamine({
      compareBranch: compareBranch ?? null,
      generatedAt: generatedAt ?? null,
      sawBackgroundRun: false,
    });
    setReexamineState("running");
    setReexamineMessage(message);
  };

  const handleReexamineError = (message) => {
    setPendingReexamine(null);
    setReexamineState("error");
    setReexamineMessage(message);
  };

  useEffect(() => {
    setLivePayload(payload);
  }, [payload]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const targetTag = target?.tagName ?? "";
      if (
        (target?.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(targetTag)) &&
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }

      if (
        event.key?.toLowerCase() === "t" &&
        event.altKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        setDebugDrawerOpen(!debugOpen);
        return;
      }

      if (event.key === "Escape" && debugOpen) {
        setDebugDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [debugOpen]);

  useEffect(() => {
    if (!(typeof controlPort === "number" && controlPort > 0)) {
      hasRedirectedRef.current = false;
      return undefined;
    }

    let disposed = false;

    const syncStatus = async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${controlPort}/control/status`,
        );
        if (!response.ok) {
          return;
        }

        const next = await response.json();
        if (disposed) {
          return;
        }

        const nextViewerStatus = next.viewer?.status ?? null;
        const nextViewerError =
          typeof next.viewer?.lastError === "string" &&
          next.viewer.lastError.trim()
            ? next.viewer.lastError
            : null;
        const nextGeneratedAt = next.reviewDebug?.generatedAt ?? null;

        setLivePayload((currentValue) => ({
          ...currentValue,
          reviewDiff: next.reviewDiff ?? currentValue.reviewDiff,
          sessionDebug: next.sessionDebug ?? currentValue.sessionDebug,
          reviewDebug: next.reviewDebug ?? currentValue.reviewDebug,
          generatedAt:
            next.reviewDebug?.generatedAt ?? currentValue.generatedAt,
          ...(next.viewer?.status === "starting"
            ? {
                tone: "loading",
                title: "OpenReview is starting",
                message:
                  currentValue.message ??
                  "Scanning this worktree and collecting context for the first OpenReview pass.",
                detail: next.viewer.lastError ?? currentValue.detail,
                autoRefreshMs: null,
              }
            : {}),
          ...(next.viewer?.status === "error" && next.viewer?.lastError
            ? {
                tone: "error",
                title: "OpenReview failed",
                message: next.viewer.lastError,
                detail: next.viewer.lastError,
                autoRefreshMs: null,
              }
            : {}),
        }));

        if (pendingReexamine && nextViewerError) {
          setPendingReexamine(null);
          setReexamineState("error");
          setReexamineMessage(nextViewerError);
          return;
        }

        if (pendingReexamine && nextViewerStatus === "starting") {
          setPendingReexamine((currentValue) =>
            currentValue && !currentValue.sawBackgroundRun
              ? { ...currentValue, sawBackgroundRun: true }
              : currentValue,
          );
        }

        if (
          pendingReexamine &&
          nextViewerStatus === "running" &&
          ((pendingReexamine.sawBackgroundRun && !nextViewerError) ||
            (nextGeneratedAt && nextGeneratedAt !== pendingReexamine.generatedAt))
        ) {
          setPendingReexamine(null);
          disposed = true;
          reloadCurrentPage();
          return;
        }

        if (
          livePayload?.pageType === "status" &&
          next.viewer?.status === "running" &&
          next.nextUrl &&
          !hasRedirectedRef.current
        ) {
          const nextUrl = new URL(next.nextUrl);
          if (debugOpen) {
            nextUrl.searchParams.set("debug", "1");
          }
          if (nextUrl.toString() !== window.location.href) {
            hasRedirectedRef.current = true;
            disposed = true;
            window.location.replace(nextUrl.toString());
          }
        }
      } catch {
        setLivePayload((currentValue) => ({
          ...currentValue,
          tone: "error",
          title: "OpenReview offline",
          message: "Lost contact with the OpenReview control service.",
          detail:
            "The background OpenReview service is not responding. Reopen OpenReview to restart it.",
          autoRefreshMs: null,
          sessionDebug: {
            ...currentValue.sessionDebug,
            viewer: {
              ...currentValue.sessionDebug?.viewer,
              status: "stopped",
            },
          },
        }));
      }
    };

    void syncStatus();
    const intervalId = window.setInterval(() => {
      void syncStatus();
    }, 4000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [controlPort, debugOpen, livePayload?.pageType, pendingReexamine]);

  useEffect(() => {
    if (
      !(typeof statusRefreshDelayMs === "number" && statusRefreshDelayMs > 0) ||
      hasRedirectedRef.current
    ) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      if (hasRedirectedRef.current) {
        return;
      }

      reloadStatusPage();
    }, statusRefreshDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [livePayload?.generatedAt, livePayload?.pageType, statusRefreshDelayMs]);

  const page = (() => {
    try {
      switch (livePayload.pageType) {
        case "status":
          return html`<${StatusPage}
            title=${livePayload.title}
            message=${livePayload.message}
            worktreePath=${livePayload.worktreePath}
            tone=${livePayload.tone}
            phase=${livePayload.phase}
            detail=${livePayload.detail}
            highlights=${livePayload.highlights}
            generatedAt=${livePayload.generatedAt}
            reviewDebug=${livePayload.reviewDebug}
            sessionDebug=${livePayload.sessionDebug}
          />`;
        case "overview":
          return html`<${OverviewGraphPage}
            payload=${livePayload}
            reexamineState=${reexamineState}
            reexamineMessage=${reexamineMessage}
            onQueueReexamine=${handleQueueReexamine}
            onReexamineError=${handleReexamineError}
            debugOpen=${debugOpen}
            onToggleDebug=${() => setDebugDrawerOpen(!debugOpen)}
          />`;
        case "document":
          return html`<${DocumentPage} payload=${livePayload} />`;
        default:
          return html`<${StatusPage}
            title="OpenReview"
            message="The viewer payload could not be loaded."
            worktreePath=${window.location.href}
            tone="error"
            reviewDebug=${livePayload.reviewDebug}
            sessionDebug=${livePayload.sessionDebug}
          />`;
      }
    } catch (error) {
      return html`<${StatusPage}
        title="OpenReview viewer failed"
        message=${String(error instanceof Error ? error.message : error)}
        worktreePath=${livePayload.worktreePath ?? window.location.href}
        tone="error"
        reviewDebug=${livePayload.reviewDebug}
        sessionDebug=${livePayload.sessionDebug}
      />`;
    }
  })();

  return html`
    <div className="viewer-app-shell">
      ${page}
      <${SessionDebugDrawer}
        open=${debugOpen}
        payload=${livePayload}
        onClose=${() => setDebugDrawerOpen(false)}
      />
    </div>
  `;
}

try {
  createRoot(document.getElementById("viewer-root")).render(
    html`<${ViewerErrorBoundary}><${ViewerApp} payload=${payload} /></${ViewerErrorBoundary}>`,
  );
} catch (error) {
  renderFatalViewerError(error);
}
