// @ts-nocheck
import { createElement, useId, useMemo, useState } from "react";
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

async function copyPromptToClipboard(prompt, setCopied) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  } catch {
    setCopied(false);
  }
}

function PromptEditorControls({
  prompt,
  setPrompt,
  copied,
  onCopy,
  primaryAction = null,
  note = "",
}) {
  const editorId = useId();

  return html`
    <label className="issue-fixer-label" htmlFor=${editorId}
      >Edit improvement prompt</label
    >
    <textarea
      id=${editorId}
      className="issue-fixer-textarea"
      value=${prompt}
      onInput=${(event) => setPrompt(event.currentTarget.value)}
      rows=${3}
    ></textarea>
    <div className="inspector-action-row">
      ${primaryAction}
      <button className="inspector-inline-action" onClick=${onCopy}>
        ${copied ? "Copied" : "Copy prompt"}
      </button>
    </div>
    ${note
      ? html`<p className="issue-fixer-note">${note}</p>`
      : null}
  `;
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
    await copyPromptToClipboard(fixPrompt, setCopied);
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
        ${issue.contract
          ? html`<div className="inspector-section">
              <p className="inspector-kicker">Why this function matters</p>
              <p className="inspector-copy issue-fixer-copy">
                <strong>${issue.contract.name}</strong> in
                <code>${issue.contract.path}</code>
              </p>
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
        ${includedFiles.length
          ? html`<p className="issue-fixer-note">
              OpenCode will include:
              <strong>${includedFiles.join(", ")}</strong>
            </p>`
          : null}
        <${PromptEditorControls}
          prompt=${fixPrompt}
          setPrompt=${setFixPrompt}
          copied=${copied}
          onCopy=${handleCopy}
          primaryAction=${html`<button
            className="btn-fix-primary"
            onClick=${handleFix}
            disabled=${sendState === "sending"}
          >
            ${sendState === "sending" ? "Sending…" : "Fix in OpenCode"}
          </button>`}
          note=${sendMessage ||
          "Use this prompt to implement the suggested interface directly in OpenCode, or copy and refine it manually."}
        />
      </div>
    </div>
  `;
}

function PromptSuggestionCard({
  issue,
  includedFiles,
  initiallyExpanded = false,
}) {
  const [prompt, setPrompt] = useState(issue.fixPrompt ?? "");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyPromptToClipboard(prompt, setCopied);
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
      <${PromptEditorControls}
        prompt=${prompt}
        setPrompt=${setPrompt}
        copied=${copied}
        onCopy=${handleCopy}
        note=${includedFiles?.length
          ? `Suggested files to inspect manually: ${includedFiles.join(", ")}`
          : "Copy and refine this prompt manually."}
      />
    </div>
  `;
}

export {
  GitReviewBranchDropdown,
  GitReviewTopbar,
  IssueFixerPanel,
  PromptSuggestionCard,
};
