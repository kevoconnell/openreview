// @ts-nocheck
import { createElement, useId, useState } from "react";
import htm from "htm";
import {
  isCombineOpportunity,
  parseCodeLocation,
} from "../services/payload";
import { getInterfaceSuggestion } from "../services/review-findings";
import {
  getSimplificationStrategyLabel,
  renderInterfaceChangePreview,
} from "./findings";
import { renderOpenInCursorLink } from "./cursor-link";

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

function normalizeStringList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
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

function GitReviewScopeToggle({
  reviewScope,
  onChange,
  disabled,
}) {
  return html`
    <div className="git-review-scope-toggle" role="group" aria-label="Review scope">
      <button
        className=${`git-review-action git-review-scope-button ${reviewScope === "branch" ? "active" : ""}`}
        onClick=${() => onChange("branch")}
        disabled=${disabled}
      >
        Branch review
      </button>
      <button
        className=${`git-review-action git-review-scope-button ${reviewScope === "repo" ? "active" : ""}`}
        onClick=${() => onChange("repo")}
        disabled=${disabled}
      >
        Whole repo
      </button>
    </div>
  `;
}

function GitReviewTopbar({
  currentBranch,
  compareBranch,
  compareOptions,
  setCompareBranch,
  compareOptionsLoading,
  reviewScope,
  onReviewScopeChange,
  onReexamine,
  reexamineState,
  reexamineMessage,
  debugOpen,
  onToggleDebug,
}) {
  const reexamineDisabled = reexamineState === "running";
  const isReexamining = reexamineState === "running";
  const isBranchReview = reviewScope !== "repo";

  return html`
    <section className="git-review-topbar">
      <div className="git-review-left">
        <${GitReviewScopeToggle}
          reviewScope=${reviewScope}
          onChange=${onReviewScopeChange}
          disabled=${reexamineDisabled}
        />
        ${isBranchReview
          ? html`
              <${GitReviewBranchDropdown}
                compareBranch=${compareBranch}
                compareOptions=${compareOptions}
                setCompareBranch=${setCompareBranch}
                loading=${compareOptionsLoading}
              />
              <span className="git-review-arrow">←</span>
              <span className="git-review-branch-name">${currentBranch}</span>
            `
          : html`
              <span className="git-review-scope-copy">
                Whole-repo review scans the full repository snapshot.
              </span>
            `}
      </div>
      <div className="git-review-right">
        ${isReexamining
          ? html`<span className="git-review-status-indicator" role="status" aria-live="polite">
              <span className="git-review-status-dot" aria-hidden="true"></span>
              ${isBranchReview ? "OpenCode is thinking…" : "OpenCode is refreshing…"}
            </span>`
          : null}
        ${isBranchReview
          ? html`<span className="git-review-scope-note">
              ${`Comparing against ${compareBranch || "your selected branch"}`}
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
          ${isReexamining
            ? isBranchReview
              ? "Analyzing…"
              : "Refreshing…"
            : isBranchReview
              ? "Reexamine"
              : "Refresh repo"}
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
  worktreePath,
  onClose,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyPromptToClipboard(fixPrompt, setCopied);
  };

  const codeLocation = parseCodeLocation(
    issue.location ?? issue.contract?.path ?? issue.path ?? "",
    worktreePath,
  );

  return html`
    <div className="issue-fixer-shell">
      <div className="issue-fixer-action-card">
        <div className="inspector-header-row">
          <div>
            <h2 className="inspector-title">
              ${issue.functionName || issue.title}
            </h2>
            ${codeLocation?.label
              ? html`<div className="inspector-header-row">
                  <p className="inspector-copy inspector-copy-secondary">
                    ${codeLocation.label}
                  </p>
                  ${renderOpenInCursorLink(issue.location, worktreePath, {
                    label: "Show in Cursor",
                  })}
                </div>`
              : null}
          </div>
          <button className="inspector-inline-action" onClick=${onClose}>
            Back
          </button>
        </div>
        ${renderInterfaceChangePreview(issue, {
          afterLabel: "After (recommended)",
        })}
        <${PromptEditorControls}
          prompt=${fixPrompt}
          setPrompt=${setFixPrompt}
          copied=${copied}
          onCopy=${handleCopy}
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
  const combineWith = normalizeStringList(issue?.combineWith);

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
            ${combineWith.map(
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
