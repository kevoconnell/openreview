// @ts-nocheck
import { createElement, useMemo, useState } from "react";
import htm from "htm";
import {
  isCombineOpportunity,
  parseCodeLocation,
} from "../services/payload";
import { getInterfaceSuggestion } from "../services/review-findings";
import {
  getSimplificationStrategyLabel,
  InterfaceSuggestionCard,
  renderInterfaceChangePreview,
} from "./findings";

const html = htm.bind(createElement);

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
  onReexamine,
  reexamineState,
  reexamineMessage,
  debugOpen,
  onToggleDebug,
}) {
  const reexamineDisabled = reexamineState === "running";
  const isReexamining = reexamineState === "running";

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
        ${isReexamining
          ? html`<span className="git-review-status-indicator" role="status" aria-live="polite">
              <span className="git-review-status-dot" aria-hidden="true"></span>
              OpenCode is thinking…
            </span>`
          : null}
        <button className="git-review-action" onClick=${onToggleDebug}>
          ${debugOpen ? "Hide debug" : "Show debug"}
        </button>
        <button
          className="git-review-action git-review-action-primary"
          onClick=${onReexamine}
          disabled=${reexamineDisabled}
        >
          ${isReexamining ? "Analyzing…" : "Reexamine"}
        </button>
      </div>
      ${isReexamining
        ? html`<div className="git-review-progress-track" aria-hidden="true">
            <div className="git-review-progress-bar"></div>
          </div>`
        : null}
    </section>
    ${reexamineMessage
      ? html`<p
          className=${[
            "inspector-copy",
            "inspector-copy-secondary",
            isReexamining ? "git-review-reexamine-message" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
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
  viewerControl,
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
    if (!viewerControl?.isAvailable?.()) {
      setSendState("error");
      setSendMessage(
        "OpenCode handoff is unavailable while the viewer service is offline.",
      );
      return;
    }

    setSendState("sending");
    setSendMessage("");

    try {
      await viewerControl.actions.sendFixPrompt({
        prompt: fixPrompt,
        files: includedFiles,
      });

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
  viewerControl,
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
    if (!viewerControl?.isAvailable?.()) {
      setSendState("error");
      setSendMessage(
        "OpenCode handoff is unavailable while the viewer service is offline.",
      );
      return;
    }

    setSendState("sending");
    setSendMessage("");

    try {
      await viewerControl.actions.sendFixPrompt({ prompt });
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

export {
  GitReviewBranchDropdown,
  GitReviewTopbar,
  IssueFixerPanel,
  PromptSuggestionCard,
};
