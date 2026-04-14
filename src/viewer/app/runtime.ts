// @ts-nocheck
import {
  Component,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { DocumentPage, OverviewGraphPage } from "./pages/overview";
import { createViewerControlClient } from "./services/control-client";
import {
  formatDebugValue,
  formatRelativeTime,
  getOpenCodeLiveEntries,
  getOpenCodeModelLabel,
  getViewerDebugMetrics,
} from "./services/debug";
import {
  getArchitectureRole,
  getArchitectureRoleEdgeLabel,
  getNodeDisplayHint,
  getNodeMeta,
  getNodeVisualState,
  getPrimaryRepoPartIdForPath,
  REPO_PART_IDS_BY_LABEL,
  REPO_PART_POSITIONS,
  REPO_PARTS_BY_ID,
  summarizeArchitectureIssues,
} from "./services/architecture";
import {
  DEFAULT_INSPECTOR_WIDTH,
  INSPECTOR_WIDTH_KEY,
  useResizablePanel,
} from "./services/panel-layout";
import {
  buildFindingsFromInsight,
  formatFindingLabel,
  getCodePreviewSnippet,
  getFindingCategoryLabel,
  getFindingIcon,
  getInterfaceSuggestion,
  getIssueMarkerLabel,
  getIssueMarkerTitle,
  getPromptPreview,
  summarizeIssues,
} from "./services/review-findings";

const html = htm.bind(createElement);

function getReviewScope(payload) {
  return payload?.reviewScope === "repo" ? "repo" : "branch";
}

function buildRefreshMessage({ reviewScope, compareBranch, pendingLabel }) {
  if (pendingLabel) {
    return pendingLabel;
  }

  return reviewScope === "repo"
    ? "The whole-repo review is thinking in the background…"
    : compareBranch
      ? `The branch review is thinking in the background. Using ${compareBranch} as the compare branch…`
      : "The branch review is thinking in the background…";
}

const payloadElement = document.getElementById("viewer-data");
const payload = payloadElement?.textContent
  ? JSON.parse(payloadElement.textContent)
  : {};
const bootstrapViewerControl = createViewerControlClient(
  payload?.sessionDebug?.viewer ?? {},
);
let mermaidInitialized = false;



function canHardResetViewer() {
  return bootstrapViewerControl.isAvailable();
}

function HardResetActions() {
  const reviewScope = getReviewScope(payload);
  const [resetState, setResetState] = useState("idle");
  const [resetMessage, setResetMessage] = useState(
    canHardResetViewer()
      ? ""
      : reviewScope === "repo"
        ? "Hard reset is unavailable until the whole-repo viewer control server is running."
        : "Hard reset is unavailable until the branch viewer control server is running.",
  );

  const handleHardReset = async () => {
    if (!canHardResetViewer() || resetState === "running") {
      return;
    }

    setResetState("running");
    setResetMessage(
      reviewScope === "repo"
        ? "Hard resetting the whole-repo viewer and rebuilding artifacts…"
        : "Hard resetting the branch viewer and rebuilding artifacts…",
    );

    try {
      await bootstrapViewerControl.actions.hardReset();
      setResetState("done");
      setResetMessage(
        reviewScope === "repo"
          ? "Whole-repo hard reset complete. Reloading…"
          : "Branch hard reset complete. Reloading…",
      );
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      setResetState("error");
      setResetMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return html`<div style=${{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
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

  const reviewScope = getReviewScope(payload);

  rootElement.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:32px;background:linear-gradient(180deg,#0a0f1b 0%, #0b1020 100%);color:#e7ecf5;font-family:Inter,ui-sans-serif,system-ui,sans-serif;"><div style="max-width:720px;width:100%;border:1px solid rgba(255,255,255,0.08);border-radius:18px;background:rgba(16,24,43,0.92);padding:24px;box-shadow:0 24px 60px rgba(2,6,23,0.45);"><p style="margin:0 0 8px;color:#9fb2ca;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">OpenReview viewer failed</p><h1 style="margin:0 0 10px;font-size:20px;">The viewer hit a runtime error</h1><p id="openreview-fatal-error-message" style="margin:0;color:#cbd5e1;line-height:1.6;white-space:pre-wrap;"></p><div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;"><button id="openreview-fatal-hard-reset" style="appearance:none;border:0;border-radius:10px;padding:11px 14px;background:#2563eb;color:#eff6ff;font-weight:600;cursor:pointer;">${reviewScope === "repo" ? "Hard reset whole repo" : "Hard reset branch review"}</button><button id="openreview-fatal-reload" style="appearance:none;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:11px 14px;background:rgba(15,23,42,0.92);color:#cbd5e1;font-weight:600;cursor:pointer;">Reload</button></div><p id="openreview-fatal-status" style="margin:14px 0 0;color:#94a3b8;line-height:1.5;"></p></div></div>`;

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
    setStatus(
      reviewScope === "repo"
        ? "Hard reset is unavailable until the whole-repo viewer control server is running."
        : "Hard reset is unavailable until the branch viewer control server is running.",
    );
  }

  reloadButton?.addEventListener("click", () => window.location.reload());
  hardResetButton?.addEventListener("click", async () => {
    if (!canHardResetViewer()) {
      return;
    }
    hardResetButton.setAttribute("disabled", "true");
    hardResetButton.style.opacity = "0.6";
    hardResetButton.style.cursor = "progress";
    setStatus(
      reviewScope === "repo"
        ? "Hard resetting the whole-repo viewer and rebuilding artifacts…"
        : "Hard resetting the branch viewer and rebuilding artifacts…",
    );
    try {
      await bootstrapViewerControl.actions.hardReset();
      setStatus(
        reviewScope === "repo"
          ? "Whole-repo hard reset complete. Reloading…"
          : "Branch hard reset complete. Reloading…",
      );
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

function getStatusPhaseIndex(phase) {
  const index = STATUS_PHASES.findIndex((entry) => entry.key === phase);
  return index === -1 ? 0 : index;
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
  payload,
}) {
  const reviewScope = getReviewScope(payload);
  const retryControl = useMemo(
    () => createViewerControlClient(sessionDebug?.viewer ?? {}),
    [sessionDebug?.viewer?.controlPort, sessionDebug?.viewer?.controlToken],
  );
  const [retryState, setRetryState] = useState("idle");
  const [retryMessage, setRetryMessage] = useState("");

  const handleRetry = async () => {
    if (!retryControl.isAvailable() || retryState === "running") {
      return;
    }

    setRetryState("running");
    setRetryMessage("");

    try {
      await retryControl.actions.hardReset();
      setRetryMessage(
        reviewScope === "repo"
          ? "Waiting for the whole-repo review to restart."
          : "Waiting for the branch review to restart.",
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
        ? reviewScope === "repo"
          ? "Retrying whole-repo review and rebuilding the viewer shell."
          : "Retrying branch review and rebuilding the viewer shell."
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
              disabled=${retryState === "running" || !retryControl.isAvailable()}
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



function ViewerApp({ payload }) {
  const [livePayload, setLivePayload] = useState(payload);
  const [reexamineState, setReexamineState] = useState("idle");
  const [reexamineMessage, setReexamineMessage] = useState("");
  const [pendingReexamine, setPendingReexamine] = useState(null);
  const debugOpen =
    new URL(window.location.href).searchParams.get("debug") === "1";
  const viewerControl = useMemo(
    () => createViewerControlClient(livePayload?.sessionDebug?.viewer ?? {}),
    [
      livePayload?.sessionDebug?.viewer?.controlPort,
      livePayload?.sessionDebug?.viewer?.controlToken,
    ],
  );
  const hasRedirectedRef = useRef(false);
  const hasReloadedAfterControlLossRef = useRef(false);
  const statusRefreshDelayMs =
    livePayload?.pageType === "status"
      ? typeof livePayload?.autoRefreshMs === "number" &&
        livePayload.autoRefreshMs > 0
        ? livePayload.autoRefreshMs
        : null
      : null;

  const reloadStatusPage = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("v", `${Date.now()}`);
    window.location.replace(nextUrl.toString());
  };

  const reloadCurrentPage = (version) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("v", String(version ?? Date.now()));
    window.location.replace(nextUrl.toString());
  };

  const handleQueueReexamine = ({
    compare,
    scope,
    generatedAt,
    message,
  }) => {
    setPendingReexamine({
      compare: {
        baseBranch: compare?.baseBranch ?? null,
        headBranch: compare?.headBranch ?? null,
      },
      scope: scope === "repo" ? "repo" : "branch",
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
    if (!viewerControl.isAvailable()) {
      hasRedirectedRef.current = false;
      return undefined;
    }

    let disposed = false;

    const syncStatus = async () => {
      try {
        const next = await viewerControl.getStatus();
        if (!next) {
          return;
        }
        if (disposed) {
          return;
        }

        hasReloadedAfterControlLossRef.current = false;

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
          setReexamineMessage(
            buildRefreshMessage({
              reviewScope: pendingReexamine.scope,
              compareBranch: pendingReexamine.compare?.baseBranch ?? null,
            }),
          );
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
          reloadCurrentPage(nextGeneratedAt);
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
        if (
          !hasRedirectedRef.current &&
          !hasReloadedAfterControlLossRef.current
        ) {
          hasReloadedAfterControlLossRef.current = true;
          disposed = true;
          if (livePayload?.pageType === "status") {
            reloadStatusPage();
          } else {
            reloadCurrentPage(Date.now());
          }
          return;
        }

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
  }, [
    viewerControl,
    debugOpen,
    livePayload?.pageType,
    pendingReexamine,
  ]);

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
            payload=${livePayload}
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
            payload=${livePayload}
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
        payload=${livePayload}
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
