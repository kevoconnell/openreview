// @ts-nocheck
import { createElement } from "react";
import htm from "htm";
import { isCombineOpportunity } from "../services/payload";
import {
  formatFindingLabel,
  getCodePreviewSnippet,
  getFindingCategoryLabel,
  getFindingIcon,
  getInterfaceSuggestion,
} from "../services/review-findings";

const html = htm.bind(createElement);

function getSimplificationStrategyLabel(value) {
  return value ? formatFindingLabel(value) : "Stabilize";
}

function InspectorPill({ label, onClick }) {
  return html`<button className="inspector-pill" onClick=${onClick}>
    ${label}
  </button>`;
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

export {
  getSimplificationStrategyLabel,
  InspectorPill,
  getInterfaceBeforePreview,
  getInterfaceAfterPreview,
  renderInterfaceChangePreview,
  InterfaceSuggestionCard,
  getFindingsForInterfaceItem,
  FindingsList,
};
