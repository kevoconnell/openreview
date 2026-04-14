// @ts-nocheck
import { createElement, useEffect, useMemo, useState } from "react";
import htm from "htm";
import { createViewerControlClient } from "../services/control-client";
import {
  getArchitectureRole,
  getArchitectureRoleEdgeLabel,
  getNodeDisplayHint,
  getNodeVisualState,
  getPrimaryRepoPartIdForPath,
  REPO_PART_IDS_BY_LABEL,
  REPO_PART_POSITIONS,
  REPO_PARTS_BY_ID,
  resolveCompareBranches,
  summarizeArchitectureIssues,
} from "../services/architecture";
import {
  DEFAULT_INSPECTOR_WIDTH,
  INSPECTOR_WIDTH_KEY,
  useResizablePanel,
} from "../services/panel-layout";
import {
  buildNormalizedPayloadArtifacts,
  getNodeSuggestionHint,
} from "../services/payload";
import {
  buildFindingsFromInsight,
  getIssueMarkerLabel,
  getIssueMarkerTitle,
  summarizeIssues,
} from "../services/review-findings";
import { DocumentPage } from "./document";
import { GitReviewTopbar, IssueFixerPanel } from "./review-controls";
import {
  ConsumerDetailsPanel,
  InterfaceDetailsPanel,
  OverviewReviewPanel,
  ProviderDetailsPanel,
  RepoPartDetailsPanel,
} from "./overview-panels";

const html = htm.bind(createElement);
const MAX_VISIBLE_SHARED_CONSUMERS = 6;

function getReviewScope(payload) {
  return payload?.reviewScope === "repo" ? "repo" : "branch";
}

function buildRefreshMessage({ reviewScope, compareBranch }) {
  return reviewScope === "repo"
    ? "The whole-repo review is refreshing in the background, and this page will update when it is ready."
    : compareBranch
      ? `The branch review is thinking in the background. Using ${compareBranch} as the compare branch, and this page will refresh when it is ready.`
      : "The branch review is thinking in the background, and this page will refresh when it is ready.";
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
  const { fileInsights, changedInterfaces, normalizePath } = useMemo(
    () =>
      buildNormalizedPayloadArtifacts({
        fileInsights: rawFileInsights,
        changedInterfaces: payload.changedInterfaces ?? [],
        graphDocument,
      }),
    [graphDocument, payload.changedInterfaces, rawFileInsights],
  );
  const changedInterfacesByKey = useMemo(
    () =>
      new Map(
        changedInterfaces.map((item) => [`${item.path}:${item.name}`, item]),
      ),
    [changedInterfaces],
  );
  const reviewDiff = payload.reviewDiff ?? { compare: { baseBranch: "" }, files: [] };
  const reviewIssues = useMemo(
    () =>
      Object.values(fileInsights).flatMap((insight) => {
        const {
          structuredInterfaceFindings,
          fallbackHeuristicFindings,
        } = buildFindingsFromInsight({
          insight,
          nodeLabel: insight?.basename ?? insight?.path ?? "file",
        });
        const structuredIssues = structuredInterfaceFindings.map((issue) => ({
          ...issue,
          contract:
            changedInterfacesByKey.get(
              `${insight?.path ?? issue.path}:${issue.functionName}`,
            ) ?? null,
        }));
        const fallbackIssues = fallbackHeuristicFindings.map((issue) => ({
          ...issue,
          contract: null,
        }));

        return structuredIssues.length ? structuredIssues : fallbackIssues;
      }),
    [changedInterfacesByKey, fileInsights],
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
    reviewDiff.compare?.headBranch ??
    (() => {
      const segments = String(payload.worktreePath ?? "")
        .split("/")
        .filter(Boolean);
      return segments[segments.length - 1] ?? "local-branch";
    })();
  const reviewScope = getReviewScope(payload);
  const viewerControl = useMemo(
    () => createViewerControlClient(payload?.sessionDebug?.viewer ?? {}),
    [
      payload?.sessionDebug?.viewer?.controlPort,
      payload?.sessionDebug?.viewer?.controlToken,
    ],
  );
  const [fetchedBranches, setFetchedBranches] = useState([]);
  const [fetchedCurrentBranch, setFetchedCurrentBranch] = useState(null);
  const [compareOptionsLoading, setCompareOptionsLoading] = useState(
    viewerControl.isAvailable(),
  );
  useEffect(() => {
    if (reviewScope === "repo") {
      setFetchedBranches([]);
      setFetchedCurrentBranch(null);
      setCompareOptionsLoading(false);
      return undefined;
    }

    if (!viewerControl.isAvailable()) {
      setFetchedBranches([]);
      setFetchedCurrentBranch(null);
      setCompareOptionsLoading(false);
      return undefined;
    }

    const abortController = new AbortController();
    setCompareOptionsLoading(true);

    void (async () => {
      try {
        const nextPayload = await viewerControl.actions.getGitBranches({
          signal: abortController.signal,
        });
        setFetchedBranches(nextPayload.branches);
        setFetchedCurrentBranch(nextPayload.currentBranch);
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
  }, [reviewScope, viewerControl]);
  const currentBranchName = fetchedCurrentBranch || branchName;
  const compareBranchResolution = useMemo(
    () =>
      resolveCompareBranches({
        reviewDiff,
        currentBranch: currentBranchName,
        fetchedBranches,
      }),
    [currentBranchName, fetchedBranches, reviewDiff],
  );
  const [compareBranch, setCompareBranch] = useState(
    compareBranchResolution.preferred,
  );
  useEffect(() => {
    if (
      (!compareBranch ||
        !compareBranchResolution.options.includes(compareBranch)) &&
      compareBranchResolution.preferred
    ) {
      setCompareBranch(compareBranchResolution.preferred);
    }
  }, [compareBranch, compareBranchResolution]);
  const activeComparison = useMemo(
    () =>
      reviewDiff.comparisons?.[compareBranch] ?? {
        files: reviewDiff.files ?? [],
        mergeBase: reviewDiff.compare?.mergeBase ?? null,
      },
    [
      compareBranch,
      reviewDiff.comparisons,
      reviewDiff.files,
      reviewDiff.compare?.mergeBase,
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
      const comparisonFilesByPath = new Map(
        (activeComparison.files ?? []).map((file) => [file.path, file]),
      );

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
        const sortedItems = [...items].sort((left, right) => {
          const consumerDelta = right.consumers.length - left.consumers.length;
          if (consumerDelta !== 0) {
            return consumerDelta;
          }

          return String(left.name ?? "").localeCompare(String(right.name ?? ""));
        });
        const consumerMap = new Map();
        for (const item of sortedItems) {
          for (const consumer of item.consumers ?? []) {
            if (!consumer?.path) {
              continue;
            }

            const existing = consumerMap.get(consumer.path) ?? {
              ...consumer,
              interfaces: [],
            };
            existing.interfaces = [
              ...new Set([...(existing.interfaces ?? []), item.name]),
            ];
            existing.state =
              existing.state === "changed" || consumer.state === "changed"
                ? "changed"
                : consumer.state ?? existing.state ?? "affected";
            if (
              String(consumer.preview ?? "").length >
              String(existing.preview ?? "").length
            ) {
              existing.preview = consumer.preview;
            }
            consumerMap.set(consumer.path, existing);
          }
        }
        const sharedConsumers = Array.from(consumerMap.values()).sort(
          (left, right) => {
            const overlapDelta =
              (right.interfaces?.length ?? 0) - (left.interfaces?.length ?? 0);
            if (overlapDelta !== 0) {
              return overlapDelta;
            }

            const leftRank = left.state === "changed" ? 0 : 1;
            const rightRank = right.state === "changed" ? 0 : 1;
            if (leftRank !== rightRank) {
              return leftRank - rightRank;
            }

            return String(left.path ?? "").localeCompare(String(right.path ?? ""));
          },
        );
        const visibleConsumers = sharedConsumers.slice(
          0,
          MAX_VISIBLE_SHARED_CONSUMERS,
        );
        const sharedConsumerCounts = Object.fromEntries(
          sharedConsumers.map((consumer) => [
            consumer.path,
            consumer.interfaces?.length ?? 0,
          ]),
        );
        const providerPartId =
          getPrimaryRepoPartIdForPath(groupPath) ??
          `part:${sortedItems[0]?.part ?? "shared"}`;
        const providerNodeId = `provider:${groupPath}`;
        const relatedFiles = (activeComparison.files ?? []).filter(
          (file) => file.path === groupPath,
        );
        const providerFindings = reviewIssues
          .filter((issue) => issue.path === groupPath)
          .map((issue) => ({ ...issue, nodeId: providerNodeId }));
        const interfaceStartY = currentY + 42;
        const consumerStartY = currentY + 42;
        const interfaceColumnHeight = sortedItems.length
          ? (sortedItems.length - 1) * 116 + 86
          : 0;
        const consumerColumnHeight = visibleConsumers.length
          ? (visibleConsumers.length - 1) * 72 + 62
          : 0;
        const groupHeight = Math.max(
          148,
          Math.max(interfaceColumnHeight, consumerColumnHeight) + 84,
        );
        const consumerNodeIdsByPath = Object.fromEntries(
          visibleConsumers.map((consumer) => [
            consumer.path,
            `consumer:${groupPath}:${consumer.path}`,
          ]),
        );
        const totalCombineSignals = sharedConsumers.filter(
          (consumer) => (consumer.interfaces?.length ?? 0) > 1,
        ).length;

        nodes.push({
          id: providerNodeId,
          type: "group",
          nodeKind: "provider",
          partId: providerPartId,
          role: "boundary",
          label: groupPath,
          path: groupPath,
          description: `Changed source file with ${sortedItems.length} shared interface${sortedItems.length === 1 ? "" : "s"}.`,
          summary: `${sortedItems.length} interfaces · ${sharedConsumers.length} consumers${totalCombineSignals ? ` · ${totalCombineSignals} shared-consumer combine signal${totalCombineSignals === 1 ? "" : "s"}` : ""}`,
          state: "changed",
          position: {
            x: 56,
            y: currentY + Math.max(0, (groupHeight - 72) / 2),
          },
          size: { width: 284, height: 72 },
        });

        findingsByNodeId[providerNodeId] = providerFindings;
        filesByNodeId[providerNodeId] = relatedFiles;
        primaryPathByNodeId[providerNodeId] = groupPath;
        summaryByNodeId[providerNodeId] =
          `${sortedItems.length} interfaces · ${sharedConsumers.length} consumers`;

        visibleConsumers.forEach((consumer, consumerIndex) => {
          const consumerNodeId = consumerNodeIdsByPath[consumer.path];
          const consumerRelatedFiles = comparisonFilesByPath.get(consumer.path)
            ? [comparisonFilesByPath.get(consumer.path)]
            : [];
          const consumerFindings = sortedItems
            .filter((item) =>
              item.consumers.some((candidate) => candidate.path === consumer.path),
            )
            .flatMap((item) =>
              reviewIssues
                .filter(
                  (issue) =>
                    issue.path === item.path &&
                    (!issue.functionName || issue.functionName === item.name),
                )
                .map((issue) => ({ ...issue, nodeId: consumerNodeId })),
            );

          nodes.push({
            id: consumerNodeId,
            type: "group",
            nodeKind: "consumer",
            partId:
              REPO_PART_IDS_BY_LABEL[String(consumer.part ?? "").toLowerCase()] ??
              getPrimaryRepoPartIdForPath(consumer.path),
            role: "adapter",
            label: consumer.path,
            path: consumer.path,
            description: consumer.preview,
            summary: `${consumer.interfaces?.length ?? 0} changed interface${consumer.interfaces?.length === 1 ? "" : "s"}${(consumer.interfaces?.length ?? 0) > 1 ? ` · ${consumer.interfaces.join(", ")}` : ""}`,
            state: consumer.state === "changed" ? "changed" : "affected",
            position: { x: 834, y: consumerStartY + consumerIndex * 72 },
            size: { width: 352, height: 62 },
          });

          findingsByNodeId[consumerNodeId] = consumerFindings;
          filesByNodeId[consumerNodeId] = consumerRelatedFiles;
          primaryPathByNodeId[consumerNodeId] = consumer.path;
          summaryByNodeId[consumerNodeId] =
            consumer.preview || `${consumer.interfaces?.length ?? 0} changed interfaces`;
        });

        sortedItems.forEach((item, interfaceIndex) => {
          const interfaceY = interfaceStartY + interfaceIndex * 116;
          const interfaceNodeId = `interface:${item.path}:${item.name}`;
          const relatedFindings = reviewIssues
            .filter(
              (issue) =>
                issue.path === item.path &&
                (!issue.functionName || issue.functionName === item.name),
            )
            .map((issue) => ({ ...issue, nodeId: interfaceNodeId }));
          const sharedConsumerCount = item.consumers.filter(
            (consumer) => (sharedConsumerCounts[consumer.path] ?? 0) > 1,
          ).length;

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
            summary: `${item.consumers.length} consumer${item.consumers.length === 1 ? "" : "s"}${sharedConsumerCount ? ` · ${sharedConsumerCount} shared with sibling interfaces` : ""}`,
            state: "changed",
            position: { x: 372, y: interfaceY },
            size: { width: 372, height: 86 },
          });

          edges.push({
            id: `edge:${providerNodeId}:${interfaceNodeId}`,
            source: providerNodeId,
            target: interfaceNodeId,
            type: "structure",
            label: "exports",
          });

          findingsByNodeId[interfaceNodeId] = relatedFindings;
          filesByNodeId[interfaceNodeId] = relatedFiles;
          primaryPathByNodeId[interfaceNodeId] = item.path;
          summaryByNodeId[interfaceNodeId] =
            `${item.consumers.length} consumers${sharedConsumerCount ? ` · ${sharedConsumerCount} shared` : ""}`;

          item.consumers.forEach((consumer) => {
            const consumerNodeId = consumerNodeIdsByPath[consumer.path];
            if (!consumerNodeId) {
              return;
            }

            edges.push({
              id: `edge:${interfaceNodeId}:${consumerNodeId}`,
              source: interfaceNodeId,
              target: consumerNodeId,
              type: "impact",
              label: "used by",
            });
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
        logicalPath: normalizePath(file.path),
      }),
    );
    const filesByNodeId = {};
    const findingsByNodeId = {};
    const primaryPathByNodeId = {};
    const summaryByNodeId = {};

    const nodes = allNodes.map((node) => {
      const nodePath = normalizePath(node.path ?? "");
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
          const issuePath = normalizePath(issue.path ?? "");
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
    changedInterfaces,
    graphDocument,
    normalizePath,
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
  const changedInterfacesByProviderPath = useMemo(
    () =>
      changedInterfaces.reduce((acc, item) => {
        if (!acc[item.path]) {
          acc[item.path] = [];
        }
        acc[item.path].push(item);
        return acc;
      }, {}),
    [changedInterfaces],
  );
  const changedInterfacesByConsumerPath = useMemo(
    () =>
      changedInterfaces.reduce((acc, item) => {
        for (const consumer of item.consumers ?? []) {
          if (!consumer?.path) {
            continue;
          }
          if (!acc[consumer.path]) {
            acc[consumer.path] = [];
          }
          if (
            !acc[consumer.path].some(
              (candidate) =>
                candidate.path === item.path && candidate.name === item.name,
            )
          ) {
            acc[consumer.path].push(item);
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
  }, [activeIssueId, interfaceGraph.findingsByNodeId]);
  useEffect(() => {
    if (!activeIssue) {
      setFixPrompt("");
      return;
    }

    setFixPrompt(activeIssue.fixPrompt ?? "");
  }, [activeIssue]);
  const resolveIssueNodeId = (issue) => {
    if (!issue) {
      return null;
    }

    if (issue.contract?.path && issue.contract?.name) {
      const interfaceNodeId = `interface:${issue.contract.path}:${issue.contract.name}`;
      if (interfaceGraph.nodes.some((node) => node.id === interfaceNodeId)) {
        return interfaceNodeId;
      }
      const providerNodeId = `provider:${issue.contract.path}`;
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
    if (typeof activeIssuePath !== "string" || !activeIssuePath.trim()) {
      return [];
    }

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
  const isBranchReview = reviewScope !== "repo";
  const handleReexamine = async () => {
    if (!viewerControl.isAvailable()) {
      onReexamineError(
        reviewScope === "repo"
          ? "Whole-repo review needs the viewer service. Start or refresh OpenReview, then try again."
          : "Branch review needs the viewer service. Start or refresh OpenReview, then try again.",
      );
      return;
    }

    const selectedCompare = isBranchReview
      ? {
          baseBranch: compareBranch || null,
          headBranch: null,
        }
      : null;
    const nextMode = isBranchReview ? "incremental" : "full";

    onQueueReexamine({
      compare: selectedCompare,
      scope: reviewScope,
      generatedAt: payload.generatedAt ?? null,
      message: buildRefreshMessage({
        reviewScope,
        compareBranch: selectedCompare?.baseBranch ?? null,
      }),
    });

    try {
      const response = await viewerControl.actions.refresh({
        mode: nextMode,
        ...(selectedCompare ? { compare: selectedCompare } : {}),
        scope: reviewScope,
      });
      if (response?.nextUrl) {
        const nextUrl = new URL(response.nextUrl);
        if (debugOpen) {
          nextUrl.searchParams.set("debug", "1");
        }
        window.location.replace(nextUrl.toString());
        return;
      }
    } catch (error) {
      onReexamineError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const handleScopeChange = async (nextScope) => {
    if (nextScope === reviewScope) {
      return;
    }

    if (!viewerControl.isAvailable()) {
      onReexamineError(
        nextScope === "repo"
          ? "Switching to whole-repo review needs the viewer service. Start or refresh OpenReview, then try again."
          : "Switching to branch review needs the viewer service. Start or refresh OpenReview, then try again.",
      );
      return;
    }

    onQueueReexamine({
      compare: null,
      scope: nextScope,
      generatedAt: payload.generatedAt ?? null,
      message:
        nextScope === "repo"
          ? "Switching to whole-repo review. The repository will be refreshed in the background, and the viewer will redirect when it is ready."
          : "Switching to branch review. The branch viewer will refresh in the background, and the viewer will redirect when it is ready.",
    });

    try {
      const response = await viewerControl.actions.refresh({
        mode: "full",
        scope: nextScope,
      });
      if (response?.nextUrl) {
        const nextUrl = new URL(response.nextUrl);
        if (debugOpen) {
          nextUrl.searchParams.set("debug", "1");
        }
        window.location.replace(nextUrl.toString());
        return;
      }

      window.location.reload();
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

  const handleOpenInterface = (node) => {
    handleSelectNode(node);
  };

  const handleSelectIssue = (issue) => {
    setActiveIssueId(issue.id);
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
          compareOptions=${compareBranchResolution.options}
          setCompareBranch=${setCompareBranch}
          compareOptionsLoading=${compareOptionsLoading}
          reviewScope=${reviewScope}
          onReviewScopeChange=${handleScopeChange}
          graphSummary=${graphSummary}
          worktreePath=${payload.worktreePath}
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
                        if (
                          node.nodeKind === "provider" ||
                          node.nodeKind === "consumer"
                        ) {
                          handleSelectNode(node);
                          return;
                        }
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
        ...${inspector.handleProps}
        className="inspector-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review rail"
      >
        <span className="inspector-resize-grip" aria-hidden="true">⋮</span>
      </div>
      <aside
        className="inspector-panel architecture-inspector-panel"
        style=${inspector.panelStyle}
      >
        ${activeIssue
            ? html`<${IssueFixerPanel}
                issue=${activeIssue}
                fixPrompt=${fixPrompt}
                setFixPrompt=${setFixPrompt}
                worktreePath=${payload.worktreePath}
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
                onSelectIssue=${handleSelectIssue}
                worktreePath=${payload.worktreePath}
              />`
            : focusedNode?.nodeKind === "provider"
              ? html`<${ProviderDetailsPanel}
                  node=${focusedNode}
                interfaceItems=${changedInterfacesByProviderPath[
                  focusedNode.path
                ] ?? []}
                findings=${issuesByNodeId[focusedNode.id] ?? []}
                selectedIssue=${activeIssue}
                onOpenInterface=${handleOpenInterface}
                onSelectIssue=${handleSelectIssue}
                worktreePath=${payload.worktreePath}
              />`
              : focusedNode?.nodeKind === "consumer"
                ? html`<${ConsumerDetailsPanel}
                    node=${focusedNode}
                    interfaceItems=${changedInterfacesByConsumerPath[
                      focusedNode.path
                    ] ?? []}
                    findings=${issuesByNodeId[focusedNode.id] ?? []}
                    selectedIssue=${activeIssue}
                    onSelectNode=${handleSelectNode}
                    onSelectIssue=${handleSelectIssue}
                    worktreePath=${payload.worktreePath}
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
                      worktreePath=${payload.worktreePath}
                    />`
                  : html`<${OverviewReviewPanel}
                      changedLayers=${layout.visibleNodes}
                      graphSummary=${graphSummary}
                      reviewDiff=${{
                        ...reviewDiff,
                        files: activeComparison.files,
                        compare: {
                          ...reviewDiff.compare,
                          baseBranch: compareBranch,
                          headBranch:
                            currentBranchName || reviewDiff.compare?.headBranch || null,
                          mergeBase:
                            activeComparison.mergeBase ??
                            reviewDiff.compare?.mergeBase ??
                            null,
                        },
                      }}
                      findings=${Object.values(issuesByNodeId).flat()}
                      changedInterfaces=${changedInterfaces}
                      changedPaths=${(activeComparison.files ?? []).map(
                        (file) => file.path,
                      )}
                      onSelectIssue=${handleSelectIssue}
                      onSelectNode=${handleSelectNode}
                      worktreePath=${payload.worktreePath}
                    />`}
      </aside>
    </div>
  `;
}

export { DocumentPage, OverviewGraphPage };
