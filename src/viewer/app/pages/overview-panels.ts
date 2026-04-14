// @ts-nocheck
import { createElement, useMemo } from "react";
import htm from "htm";
import { summarizeArchitectureIssues } from "../services/architecture";
import {
  getCollapsedAliasPaths,
  isCombineOpportunity,
  normalizeFileReference,
  normalizeInsight,
  parseCodeLocation,
} from "../services/payload";
import {
  FindingsList,
  getFindingsForInterfaceItem,
  InspectorPill,
  InterfaceSuggestionCard,
} from "./findings";
import { PromptSuggestionCard } from "./review-controls";

const html = htm.bind(createElement);

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
  viewerControl,
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
                                viewerControl=${viewerControl}
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

export {
  renderSourceOfTruthMeta,
  getScorecardTone,
  ArchitectureScorecard,
  DiffFileList,
  OverviewReviewPanel,
  GroupDetailsPanel,
  FileDetailsPanel,
  RepoPartDetailsPanel,
  InterfaceDetailsPanel,
};
