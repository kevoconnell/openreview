import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureViewerBundle } from "./build-viewer-bundle.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getViewerAssetDirCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [moduleDir, path.resolve(moduleDir, "../../src/viewer")];
}

async function readViewerAppJs(): Promise<string> {
  for (const candidate of getViewerAssetDirCandidates()) {
    const viewerAppJsPath = path.join(candidate, "viewer-app.bundle.js");
    if (await pathExists(viewerAppJsPath)) {
      return fs.readFile(viewerAppJsPath, "utf8");
    }
  }

  return ensureViewerBundle();
}

async function getViewerOverridesSourcePath(): Promise<string> {
  for (const candidate of getViewerAssetDirCandidates()) {
    const viewerOverridesSourcePath = path.join(candidate, "viewer-overrides.css");
    if (await pathExists(viewerOverridesSourcePath)) {
      return viewerOverridesSourcePath;
    }
  }

  throw new Error("Could not locate checked-in OpenReview viewer CSS assets");
}

function getViewerRuntimeRoot({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(repoPath, outputDirName, "runtime", "viewer");
}

function getDefaultViewerWorkspaceDir({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): string {
  return path.join(
    getViewerRuntimeRoot({ repoPath, outputDirName }),
    "workspace-default",
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildViewerHtmlTemplate({ title }: { title: string }): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle} · OpenReview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --bg-soft: #10182b;
        --bg-elevated: #152039;
        --panel: rgba(16, 24, 43, 0.92);
        --panel-soft: rgba(15, 23, 42, 0.82);
        --border: rgba(255, 255, 255, 0.08);
        --border-strong: rgba(125, 211, 252, 0.2);
        --text: #e7ecf5;
        --muted: #96a3b8;
        --muted-strong: #cbd5e1;
        --accent: #7dd3fc;
        --accent-2: #38bdf8;
        --accent-3: #2563eb;
        --warning: #f59e0b;
        --success: #22c55e;
        --danger: #ef4444;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg);
        color: var(--text);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        overflow-x: hidden;
        background: linear-gradient(180deg, #0a0f1b 0%, #0b1020 100%);
        color: var(--text);
      }

      button {
        font: inherit;
      }

      a {
        color: var(--accent);
      }

      code,
      pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      code {
        background: rgba(125, 211, 252, 0.08);
        border: 1px solid rgba(125, 211, 252, 0.12);
        border-radius: 6px;
        padding: 0.12rem 0.35rem;
      }

      pre {
        margin: 0;
        overflow: auto;
      }

      .viewer-root {
        min-height: 100vh;
      }

      .overview-shell,
      .status-shell,
      .status-page {
        min-height: 100vh;
        background: linear-gradient(180deg, #0a0f1b 0%, #0b1020 100%);
        color: var(--text);
      }

      .overview-shell {
        display: flex;
        width: 100%;
        height: 100vh;
        max-height: 100vh;
        overflow: hidden;
      }

      .graph-page,
      .architecture-canvas-shell {
        flex: 1 1 auto;
        height: 100vh;
        max-height: 100vh;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .git-review-topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border);
        background: rgba(7, 13, 24, 0.92);
        position: sticky;
        top: 0;
        z-index: 20;
        backdrop-filter: blur(14px);
      }

      .git-review-left,
      .git-review-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .git-review-arrow,
      .git-review-files,
      .page-subtitle,
      .inspector-copy,
      .inspector-copy-secondary,
      .status-shell-copy,
      .status-meta,
      .status-inline-meta,
      .graph-node-secondary,
      .graph-left-sidebar-meta,
      .timeline-footer-copy {
        color: var(--muted);
      }

      .git-review-branch-name,
      .page-title,
      .inspector-title,
      .inspector-summary-title,
      .status-shell-title,
      .status-copy h1 {
        color: var(--text);
      }

      .git-review-action,
      .status-shell-list-action,
      .viewer-debug-toggle,
      .panel-close {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(15, 23, 42, 0.82);
        color: var(--text);
        border-radius: 12px;
        padding: 10px 14px;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      }

      .git-review-action:hover,
      .status-shell-list-action:hover,
      .viewer-debug-toggle:hover,
      .panel-close:hover {
        border-color: rgba(125, 211, 252, 0.35);
        background: rgba(30, 41, 59, 0.95);
        transform: translateY(-1px);
      }

      .git-review-action-primary {
        background: linear-gradient(180deg, rgba(37, 99, 235, 0.95), rgba(29, 78, 216, 0.95));
        border-color: rgba(96, 165, 250, 0.45);
        color: #eff6ff;
      }

      .git-review-action[disabled],
      .viewer-debug-toggle[disabled],
      .panel-close[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }

      .graph-shell {
        flex: 1;
        display: flex;
        min-height: 0;
      }

      .graph-shell-reference {
        flex: 1 1 auto;
        min-height: 0;
        min-width: 0;
      }

      .graph-canvas {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 24px;
      }

      .graph-stage {
        position: relative;
        margin: 0 auto;
        transform-origin: top center;
      }

      .graph-svg {
        position: absolute;
        inset: 0;
        overflow: visible;
      }

      .graph-empty,
      .file-panel-empty {
        margin: auto;
        padding: 32px;
        color: var(--muted);
        text-align: center;
      }

      .graph-node {
        position: absolute;
        display: flex;
        width: 226px;
        text-align: left;
        padding: 14px 16px 14px 18px;
        border-radius: 16px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(9, 16, 28, 0.96);
        color: var(--text);
        box-shadow: 0 12px 28px rgba(2, 6, 23, 0.22);
        cursor: pointer;
      }

      .graph-node-selected {
        border-color: rgba(125, 211, 252, 0.55);
        box-shadow: 0 18px 42px rgba(37, 99, 235, 0.22);
      }

      .graph-node-rail {
        position: absolute;
        left: 0;
        top: 10px;
        bottom: 10px;
        width: 4px;
        border-radius: 999px;
        background: rgba(125, 211, 252, 0.45);
      }

      .node-content,
      .node-text {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }

      .graph-node-label {
        font-weight: 600;
        line-height: 1.35;
        word-break: break-word;
      }

      .graph-issue-marker {
        position: absolute;
        top: -8px;
        right: -8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(15, 23, 42, 0.96);
        box-shadow: 0 8px 20px rgba(2,6,23,0.28);
      }

      .graph-edge-label-text {
        fill: #dbeafe;
        font-size: 10px;
        text-anchor: middle;
      }

      .graph-edge-label-bg {
        fill: rgba(15, 23, 42, 0.94);
        stroke: rgba(125, 211, 252, 0.16);
      }

      .content-shell {
        display: flex;
        min-height: calc(100vh - 61px);
        width: 100%;
        overflow: hidden;
      }

      .document-main {
        flex: 1;
        min-width: 0;
        padding: 24px 28px 28px;
        overflow: auto;
      }

      .content {
        max-width: none;
        margin: 0;
        padding: 28px 34px;
        background: rgba(16, 24, 43, 0.78);
        border: 1px solid var(--border);
        border-radius: 18px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
      }

      .file-panel-card,
      .viewer-debug-card,
      .status-shell-card,
      .status-card,
      .status-shell-sidebar-card,
      .inspector-summary-card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        box-shadow: 0 16px 40px rgba(2, 6, 23, 0.2);
      }

      .inspector-panel,
      .architecture-inspector-panel {
        flex: 0 0 320px;
        width: 320px;
        min-width: 320px;
        max-width: 320px;
        height: 100vh;
        max-height: 100vh;
        padding: 18px;
        overflow-y: auto;
        overflow-x: hidden;
        box-sizing: border-box;
        align-self: flex-start;
        background: rgba(10, 15, 27, 0.4);
        backdrop-filter: blur(12px);
        overflow-wrap: anywhere;
      }

      .inspector-panel,
      .architecture-inspector-panel {
        border-left: 1px solid var(--border);
      }

      .inspector-detail-panel {
        display: block;
        min-width: 0;
      }

      .inspector-resize-handle {
        flex: 0 0 14px;
        width: 14px;
        min-width: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: col-resize;
        background: rgba(7, 13, 24, 0.82);
        border-left: 1px solid rgba(255, 255, 255, 0.04);
        border-right: 1px solid rgba(255, 255, 255, 0.04);
      }

      .inspector-resize-grip {
        color: var(--muted);
        font-size: 14px;
        line-height: 1;
        user-select: none;
      }

      .file-panel-card,
      .viewer-debug-card,
      .inspector-summary-card,
      .status-shell-sidebar-card,
      .status-shell-card,
      .status-card {
        padding: 18px;
      }

      .file-panel-header,
      .viewer-debug-drawer-header,
      .inspector-header-row,
      .page-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .inspector-kicker,
      .status-shell-kicker,
      .graph-left-sidebar-kicker,
      .graph-drawer-title {
        margin: 0 0 8px;
        color: #9fb2ca;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .inspector-copy,
      .status-shell-copy,
      .inspector-summary-copy,
      .status-copy p {
        line-height: 1.6;
      }

      .status-page,
      .status-shell {
        display: grid;
        place-items: center;
        padding: 32px;
      }

      .status-card,
      .status-shell-card {
        width: min(760px, 100%);
      }

      .status-pill,
      .inspector-stat-pill,
      .risk-chip,
      .viewer-debug-chip,
      .status-shell-chip,
      .graph-domain-chip,
      .finding-domain-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid rgba(125, 211, 252, 0.16);
        background: rgba(125, 211, 252, 0.08);
        color: var(--muted-strong);
        font-size: 12px;
      }

      .status-hero {
        display: flex;
        align-items: center;
        gap: 18px;
        margin: 18px 0;
      }

      .status-orb {
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: var(--accent-2);
        box-shadow: 0 0 0 10px rgba(56, 189, 248, 0.14);
      }

      .status-orb.error {
        background: var(--danger);
        box-shadow: 0 0 0 10px rgba(239, 68, 68, 0.14);
      }

      .status-skeleton,
      .inspector-stat-grid,
      .risk-chips,
      .viewer-debug-chip-row,
      .review-findings-groups,
      .finding-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .status-skeleton-line,
      .status-shell-line,
      .status-shell-line-short {
        height: 10px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(148,163,184,0.18), rgba(125,211,252,0.14), rgba(148,163,184,0.18));
      }

      .status-skeleton-line { width: 100%; }
      .status-skeleton-line.short,
      .status-shell-line-short { width: 60%; }
      .status-shell-line { width: 100%; }

      .viewer-debug-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(2, 6, 23, 0.55);
        backdrop-filter: blur(4px);
      }

      .viewer-debug-drawer {
        position: fixed;
        top: 0;
        right: 0;
        width: min(720px, 92vw);
        height: 100vh;
        background: rgba(8, 13, 23, 0.98);
        border-left: 1px solid var(--border);
        box-shadow: -24px 0 60px rgba(2,6,23,0.35);
        z-index: 50;
        display: flex;
        flex-direction: column;
      }

      .viewer-debug-drawer-header,
      .viewer-debug-drawer-body {
        padding: 18px 20px;
      }

      .viewer-debug-drawer-body {
        overflow: auto;
        display: grid;
        gap: 14px;
        min-width: 0;
      }

      .viewer-debug-pre,
      .finding-code-preview,
      .issue-fixer-textarea {
        width: 100%;
        max-width: 100%;
        background: rgba(7, 13, 24, 0.92);
        color: var(--muted-strong);
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 12px;
        padding: 12px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .issue-fixer-textarea {
        min-height: 96px;
        resize: vertical;
      }

      .git-review-select {
        min-width: 220px;
        max-width: min(320px, calc(100vw - 40px));
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(15, 23, 42, 0.82);
        color: var(--text);
        padding: 10px 14px;
      }

      @media (max-width: 760px) {
        .content-shell,
        .graph-shell {
          flex-direction: column;
        }

        .inspector-panel,
        .architecture-inspector-panel {
          width: auto;
          min-width: 0;
          max-height: 42vh;
        }
      }
    </style>
    <link rel="stylesheet" href="./viewer-overrides.css" />
  </head>
  <body>
    <div id="viewer-root"></div>
    <script id="viewer-data" type="application/json">{}</script>
    <script>
      const loadOptionalScript = (src) => {
        return new Promise((resolve) => {
          const script = document.createElement("script");
          script.src = src;
          script.async = false;
          script.crossOrigin = "anonymous";
          script.onload = () => resolve();
          script.onerror = () => resolve();
          document.head.appendChild(script);
        });
      };

      const loadViewerApp = () => {
        return new Promise((resolve, reject) => {
          const viewerScript = document.createElement("script");
          viewerScript.src = "./viewer-app.js";
          viewerScript.onload = () => resolve();
          viewerScript.onerror = () => reject(new Error("Failed to load viewer runtime."));
          document.body.appendChild(viewerScript);
        });
      };

      const renderBootstrapError = (message) => {
        const root = document.getElementById("viewer-root");
        if (!root) return;
        root.innerHTML = '<div style="min-height:100vh;display:grid;place-items:center;padding:32px;background:linear-gradient(180deg,#0a0f1b 0%, #0b1020 100%);color:#e7ecf5;font-family:Inter,ui-sans-serif,system-ui,sans-serif;"><div style="max-width:720px;width:100%;border:1px solid rgba(255,255,255,0.08);border-radius:18px;background:rgba(16,24,43,0.92);padding:24px;box-shadow:0 24px 60px rgba(2,6,23,0.45);"><p style="margin:0 0 8px;color:#9fb2ca;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">OpenReview bootstrap failed</p><h1 style="margin:0 0 10px;font-size:20px;">Viewer could not finish loading</h1><p style="margin:0;color:#cbd5e1;line-height:1.6;white-space:pre-wrap;">' + String(message) + '</p></div></div>';
      };

      void (async () => {
        try {
          await loadOptionalScript("https://unpkg.com/react-grab/dist/index.global.js");
          await loadViewerApp();
        } catch (error) {
          renderBootstrapError(error instanceof Error ? error.message : String(error));
        }
      })();
    </script>
  </body>
</html>
`;
}

async function listViewerWorkspaceDirs({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): Promise<string[]> {
  const runtimeRoot = getViewerRuntimeRoot({ repoPath, outputDirName });

  let entryNames: string[] = [];
  try {
    entryNames = await fs.readdir(runtimeRoot);
  } catch {
    return [];
  }

  const workspaceDirs = await Promise.all(
    entryNames.map(async (entryName) => {
      const workspaceDir = path.join(runtimeRoot, entryName);
      try {
        const stat = await fs.stat(workspaceDir);
        return stat.isDirectory() ? workspaceDir : null;
      } catch {
        return null;
      }
    }),
  );

  return workspaceDirs.filter(
    (workspaceDir): workspaceDir is string => workspaceDir !== null,
  );
}

export async function syncCheckedInViewerAssets({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string;
  outputDirName?: string;
}): Promise<number> {
  const discoveredWorkspaceDirs = await listViewerWorkspaceDirs({
    repoPath,
    outputDirName,
  });
  const workspaceDirs = discoveredWorkspaceDirs.length
    ? discoveredWorkspaceDirs
    : [getDefaultViewerWorkspaceDir({ repoPath, outputDirName })];

  const [viewerAppJs, viewerOverridesSourcePath] = await Promise.all([
    readViewerAppJs(),
    getViewerOverridesSourcePath(),
  ]);

  await Promise.all(
    workspaceDirs.map((workspaceDir) => fs.mkdir(workspaceDir, { recursive: true })),
  );

  const repoTitle = path.basename(repoPath);
  const indexHtml = buildViewerHtmlTemplate({ title: repoTitle });

  await Promise.all(
    workspaceDirs.flatMap((workspaceDir) => [
      fs.writeFile(path.join(workspaceDir, "viewer-app.js"), viewerAppJs),
      fs.copyFile(
        viewerOverridesSourcePath,
        path.join(workspaceDir, "viewer-overrides.css"),
      ),
      fs.writeFile(path.join(workspaceDir, "index.html"), indexHtml, "utf8"),
      fs.writeFile(path.join(workspaceDir, "overview.html"), indexHtml, "utf8"),
    ]),
  );

  return workspaceDirs.length;
}
