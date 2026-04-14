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

function CursorLogo() {
  return html`<svg
    viewBox="0 0 32 32"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    className="inspector-cursor-link-logo"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="m16 30l12-20v14zM4 10l12-8l12 8zm0 0l12 6v14L4 24z"
    />
  </svg>`;
}

function renderOpenInCursorLink(value, worktreePath) {
  const codeLocation = parseCodeLocation(value ?? "", worktreePath);
  if (!codeLocation) {
    return null;
  }

  return html`<a
    className="inspector-cursor-link"
    href=${codeLocation.cursorUrl}
    aria-label=${`Open ${codeLocation.label} in Cursor`}
    title=${`Open ${codeLocation.label} in Cursor`}
  >
    <${CursorLogo} />
    <span>Open in Cursor</span>
  </a>`;
}

function renderSourceOfTruthMeta(entity, worktreePath) {
  const sourceOfTruthPath = entity?.sourceOfTruthPath ?? entity?.path;
  const aliasPaths = getCollapsedAliasPaths(entity);

  if (!sourceOfTruthPath || !aliasPaths.length) {
    return null;
  }

  return html`
    <div className="inspector-section">
      <p className="inspector-kicker">Source of truth</p>
      <div className="inspector-pill-grid">
        ${renderOpenInCursorLink(sourceOfTruthPath, worktreePath)}
      </div>
      <p className="inspector-copy inspector-copy-secondary">
        This viewer collapses duplicate generated/runtime surfaces into one
        logical interface.
      </p>
      <div className="inspector-pill-grid">
        ${aliasPaths.map(
          (aliasPath) =>
            html`<span key=${aliasPath}>${renderOpenInCursorLink(
              aliasPath,
              worktreePath,
            )}</span>`,
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

function getInterfaceNodeId(item) {
  return `interface:${item.path}:${item.name}`;
}

function buildPromptIncludedFiles(item, finding = null) {
  const next = [];
  const seen = new Set();

  const pushFile = (value) => {
    const filePath = normalizeFileReference(value);
    if (!filePath || seen.has(filePath)) {
      return;
    }
    seen.add(filePath);
    next.push(filePath);
  };

  pushFile(finding?.contract?.path ?? finding?.path ?? item?.path);
  for (const consumer of item?.consumers?.slice?.(0, 3) ?? []) {
    pushFile(consumer?.path);
  }

  return next;
}

function buildSharedConsumerList(interfaceItems = []) {
  const next = new Map();

  for (const item of interfaceItems) {
    for (const consumer of item.consumers ?? []) {
      if (!consumer?.path) {
        continue;
      }

      const existing = next.get(consumer.path) ?? {
        path: consumer.path,
        preview: consumer.preview,
        interfaces: [],
      };

      existing.interfaces = [
        ...new Set([...(existing.interfaces ?? []), item.name]),
      ];
      if (
        String(consumer.preview ?? "").length >
        String(existing.preview ?? "").length
      ) {
        existing.preview = consumer.preview;
      }

      next.set(consumer.path, existing);
    }
  }

  return Array.from(next.values()).sort((left, right) => {
    const overlapDelta = right.interfaces.length - left.interfaces.length;
    if (overlapDelta !== 0) {
      return overlapDelta;
    }

    return String(left.path ?? "").localeCompare(String(right.path ?? ""));
  });
}

function buildInterfaceDetailsModel(interfaceItem, primaryFinding) {
  return {
    name:
      interfaceItem?.name ||
      primaryFinding?.contract?.name ||
      primaryFinding?.functionName ||
      primaryFinding?.title ||
      "Interface",
    declaration:
      interfaceItem?.declaration ||
      interfaceItem?.currentDeclaration ||
      primaryFinding?.current ||
      primaryFinding?.before ||
      "No current interface preview available.",
    path:
      interfaceItem?.path ||
      primaryFinding?.contract?.path ||
      primaryFinding?.path ||
      "",
    current:
      primaryFinding?.current ||
      interfaceItem?.currentDeclaration ||
      interfaceItem?.previewSnippet ||
      interfaceItem?.snippet ||
      interfaceItem?.declaration ||
      "",
    suggestions: primaryFinding?.suggestions ?? [],
    consumers: interfaceItem?.consumers ?? [],
    consumerParts:
      interfaceItem?.consumerParts ?? primaryFinding?.contract?.consumerParts ?? [],
  };
}

function findInterfaceItemForFinding(finding, changedInterfaces = []) {
  const targetPath = normalizeFileReference(
    finding?.contract?.path ?? finding?.path ?? "",
  );
  const targetName = String(
    finding?.contract?.name ?? finding?.functionName ?? "",
  ).trim();

  return (
    changedInterfaces.find((item) => {
      const itemPath = normalizeFileReference(item?.path ?? "");
      const itemName = String(item?.name ?? "").trim();
      return itemPath === targetPath && itemName === targetName;
    }) ??
    changedInterfaces.find(
      (item) => getFindingsForInterfaceItem({ item, findings: [finding] }).length > 0,
    ) ??
    null
  );
}

function InterfaceImprovementDetails({
  title,
  interfaceItem,
  findings,
  onSelectIssue,
  onSelectNode,
  worktreePath,
  compactConsumers = false,
}) {
  const primaryFinding = findings[0] ?? null;
  const details = buildInterfaceDetailsModel(interfaceItem, primaryFinding);
  const codeLocation = parseCodeLocation(
    primaryFinding?.location ?? details.path,
    worktreePath,
  );
  const visibleConsumers = compactConsumers
    ? details.consumers.slice(0, 3)
    : details.consumers;
  const hiddenConsumerCount = details.consumers.length - visibleConsumers.length;

  return html`
    <div>
      <${InterfaceSuggestionCard}
        title=${title || details.name}
        path=${codeLocation?.label ?? details.path}
        metaContent=${renderOpenInCursorLink(
          primaryFinding?.location ?? details.path,
          worktreePath,
        )}
        consumerLabel=${details.consumerParts?.length
          ? `${details.consumerParts.length} consumers affected`
          : ""}
        current=${details.current}
        suggestions=${details.suggestions}
      />
      ${interfaceItem ? renderSourceOfTruthMeta(interfaceItem, worktreePath) : null}
      <div className="inspector-section">
        <p className="inspector-kicker">Consumers</p>
        <div className="inspector-list inspector-list-compact">
          ${visibleConsumers.length
            ? visibleConsumers.map(
                (consumer) =>
                  html`<div
                    key=${consumer.path}
                    className="inspector-list-item static"
                  >
                    <span>
                      <strong>${consumer.path.split("/").slice(-1)[0]}</strong>
                      ${renderOpenInCursorLink(consumer.path, worktreePath)}
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
        ${hiddenConsumerCount > 0
          ? html`<p className="inspector-copy inspector-copy-secondary">
              ${hiddenConsumerCount} more consumer${hiddenConsumerCount === 1
                ? ""
                : "s"} hidden in this summary.
            </p>`
          : null}
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

function OverviewReviewPanel({
  changedLayers,
  graphSummary,
  reviewDiff,
  findings,
  changedInterfaces,
  changedPaths,
  onSelectNode,
  onSelectIssue,
  worktreePath,
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
  const importantFindingCards = useMemo(
    () =>
      importantFindings.map((finding) => ({
        finding,
        interfaceItem: findInterfaceItemForFinding(finding, changedInterfaces),
      })),
    [changedInterfaces, importantFindings],
  );

  return html`
    <div>
      <div className="inspector-section">
        <p className="inspector-kicker">Top improvements to make</p>
        ${importantFindingCards.length
          ? html`<div className="review-findings-groups">
              ${importantFindingCards.map(
                ({ finding, interfaceItem }) =>
                  html`<div
                    key=${finding.id}
                    className="inspector-list-item static interface-improvement-card"
                  >
                    <${InterfaceImprovementDetails}
                      title=${finding.functionName || finding.title}
                      interfaceItem=${interfaceItem}
                      findings=${[finding]}
                      onSelectIssue=${onSelectIssue}
                      onSelectNode=${onSelectNode}
                      worktreePath=${worktreePath}
                      compactConsumers=${true}
                    />
                  </div>`,
              )}
            </div>`
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
  worktreePath,
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
        ${renderOpenInCursorLink(node.path ?? node.label, worktreePath)}
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
  onSelectIssue,
  worktreePath,
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
                    ${renderOpenInCursorLink(item.path, worktreePath)}
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
                                initiallyExpanded=${selectedIssue?.id ===
                                finding.id}
                                includedFiles=${buildPromptIncludedFiles(
                                  item,
                                  finding,
                                )}
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
                    ${renderOpenInCursorLink(file.path, worktreePath)}
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

function ProviderDetailsPanel({
  node,
  interfaceItems,
  findings,
  selectedIssue,
  onSelectNode,
  onSelectIssue,
  worktreePath,
}) {
  const sharedConsumers = buildSharedConsumerList(interfaceItems);
  const combineSignals = sharedConsumers.filter(
    (consumer) => consumer.interfaces.length > 1,
  );

  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">
            ${`${interfaceItems.length} changed interface${interfaceItems.length === 1 ? "" : "s"} currently feed ${sharedConsumers.length} downstream consumer${sharedConsumers.length === 1 ? "" : "s"}.`}
          </p>
          <p className="inspector-copy inspector-copy-secondary">
            Prioritize consumers that depend on multiple sibling functions. Those
            are the clearest combine candidates.
          </p>
        </div>
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Shared consumers</p>
        <div className="inspector-list inspector-list-compact">
          ${sharedConsumers.length
            ? sharedConsumers.map(
                (consumer) =>
                  html`<div
                    key=${consumer.path}
                    className="inspector-list-item static"
                  >
                    <span>
                      <strong>${consumer.path.split("/").slice(-1)[0]}</strong>
                      <span className="inspector-copy inspector-copy-secondary"
                        >Uses ${consumer.interfaces.join(", ")}</span
                      >
                      ${consumer.preview
                        ? html`<span
                            className="inspector-copy inspector-copy-secondary"
                            >${consumer.preview}</span
                          >`
                        : null}
                    </span>
                  </div>`,
              )
            : html`<div className="inspector-list-item static muted">
                <span>No downstream consumers were detected for this file.</span>
              </div>`}
        </div>
      </div>
      ${combineSignals.length
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Combine signals</p>
            <div className="inspector-list inspector-list-compact">
              ${combineSignals.map(
                (consumer) =>
                  html`<div
                    key=${`${consumer.path}:combine`}
                    className="inspector-list-item static"
                  >
                    <span>
                      <strong>${consumer.path.split("/").slice(-1)[0]}</strong>
                      <span className="inspector-copy inspector-copy-secondary"
                        >This consumer depends on ${consumer.interfaces.length}
                        changed interfaces: ${consumer.interfaces.join(", ")}</span
                      >
                    </span>
                  </div>`,
              )}
            </div>
          </div>`
        : null}
      <div className="inspector-section">
        <p className="inspector-kicker">Changed interfaces</p>
        <div className="inspector-list inspector-list-compact">
          ${interfaceItems.map((item) => {
            const matchingFindings = getFindingsForInterfaceItem({
              item,
              findings,
            });
            return html`<div
              key=${getInterfaceNodeId(item)}
              className="inspector-list-item static interface-improvement-card"
            >
              <div>
                <button
                  className="inspector-inline-action"
                  onClick=${() =>
                    onSelectNode({
                      id: getInterfaceNodeId(item),
                      label: item.name,
                      path: item.path,
                      nodeKind: "interface",
                    })}
                >
                  Open interface
                </button>
                <strong>${item.name}</strong>
                <span className="inspector-copy inspector-copy-secondary"
                  >${item.currentDeclaration || item.declaration}</span
                >
                <span className="inspector-copy inspector-copy-secondary"
                  >${item.consumers.length} consumers</span
                >
                ${matchingFindings.length
                  ? html`<div className="interface-prompt-stack">
                      ${matchingFindings.map(
                        (finding) =>
                          html`<${PromptSuggestionCard}
                            key=${finding.id}
                            issue=${finding}
                            initiallyExpanded=${selectedIssue?.id === finding.id}
                            includedFiles=${buildPromptIncludedFiles(
                              item,
                              finding,
                            )}
                          />`,
                      )}
                    </div>`
                  : null}
              </div>
            </div>`;
          })}
        </div>
      </div>
    </div>
  `;
}

function ConsumerDetailsPanel({
  node,
  interfaceItems,
  findings,
  selectedIssue,
  onSelectNode,
  onSelectIssue,
  worktreePath,
}) {
  const combineSignal = interfaceItems.length > 1;

  return html`
    <div>
      <div className="inspector-header-row">
        <div>
          <h2 className="inspector-title">${node.label}</h2>
          <p className="inspector-copy">
            This consumer currently depends on ${interfaceItems.length} changed
            interface${interfaceItems.length === 1 ? "" : "s"}.
          </p>
          <p className="inspector-copy inspector-copy-secondary">
            ${combineSignal
              ? "Because this consumer touches multiple changed entrypoints, check whether those functions are really different jobs or should collapse into one clearer API."
              : "This consumer only touches one changed entrypoint right now."}
          </p>
        </div>
        ${renderOpenInCursorLink(node.path ?? node.label, worktreePath)}
      </div>
      <div className="inspector-section">
        <p className="inspector-kicker">Consumed interfaces</p>
        <div className="inspector-list inspector-list-compact">
          ${interfaceItems.length
            ? interfaceItems.map((item) => {
                const matchingFindings = getFindingsForInterfaceItem({
                  item,
                  findings,
                });
                return html`<div
                  key=${getInterfaceNodeId(item)}
                  className="inspector-list-item static interface-improvement-card"
                >
                  <div>
                    <button
                      className="inspector-inline-action"
                      onClick=${() =>
                        onSelectNode({
                          id: getInterfaceNodeId(item),
                          label: item.name,
                          path: item.path,
                          nodeKind: "interface",
                        })}
                    >
                      Open interface
                    </button>
                    <strong>${item.name}</strong>
                    ${renderOpenInCursorLink(item.path, worktreePath)}
                    <span className="inspector-copy inspector-copy-secondary"
                      >${item.currentDeclaration || item.declaration}</span
                    >
                    ${matchingFindings.length
                      ? html`<div className="interface-prompt-stack">
                          ${matchingFindings.map(
                            (finding) =>
                              html`<${PromptSuggestionCard}
                                key=${finding.id}
                                issue=${finding}
                                initiallyExpanded=${selectedIssue?.id ===
                                finding.id}
                                includedFiles=${buildPromptIncludedFiles(
                                  item,
                                  finding,
                                )}
                              />`,
                          )}
                        </div>`
                      : null}
                  </div>
                </div>`;
              })
            : html`<div className="inspector-list-item static muted">
                <span>No changed interfaces are linked to this consumer.</span>
              </div>`}
        </div>
      </div>
      ${combineSignal
        ? html`<div className="inspector-section">
            <p className="inspector-kicker">Combine signal</p>
            <p className="inspector-copy inspector-copy-secondary">
              One consumer needing several changed sibling interfaces is often a
              sign that the boundary is making consumers choose among variants
              instead of calling one clear entrypoint.
            </p>
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
  return html`
    <${InterfaceImprovementDetails}
      title=${node.label}
      interfaceItem=${interfaceItem}
      findings=${findings}
      onSelectIssue=${onSelectIssue}
      worktreePath=${worktreePath}
    />
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
  ProviderDetailsPanel,
  ConsumerDetailsPanel,
  InterfaceDetailsPanel,
};
