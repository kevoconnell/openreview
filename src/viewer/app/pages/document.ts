// @ts-nocheck
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import htm from "htm";
import { marked } from "marked";
import mermaid from "mermaid";
import {
  DEFAULT_INSPECTOR_WIDTH,
  INSPECTOR_WIDTH_KEY,
  useResizablePanel,
} from "../services/panel-layout";
import { buildNormalizedPayloadArtifacts } from "../services/payload";

const html = htm.bind(createElement);
let mermaidInitialized = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  resolveFileInsight,
  selectedPath,
  onSelectPath,
}) {
  const contentRef = useRef(null);
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
  const { fileInsights, resolveFileInsight } = useMemo(
    () =>
      buildNormalizedPayloadArtifacts({
        fileInsights: payload.fileInsightsIndex?.files ?? {},
      }),
    [payload.fileInsightsIndex?.files],
  );
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
    <div className="content-shell viewer-root">
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
            resolveFileInsight=${resolveFileInsight}
            selectedPath=${selectedPath}
            onSelectPath=${setSelectedPath}
          />
        </article>
      </main>
      <div
        ...${inspector.handleProps}
        className="inspector-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details panel"
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

export { escapeHtml, InsightContent, MarkdownContent, DocumentPage };
