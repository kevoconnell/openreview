// @ts-nocheck

export function formatDebugValue(value) {
  if (value === null || typeof value === "undefined") {
    return "—";
  }

  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "[]";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

export function getViewerDebugMetrics(payload) {
  const reviewDiff = payload.reviewDiff ?? null;
  const reviewIssues = payload.reviewIssues ?? [];
  const graphDocument = payload.graphDocument ?? null;

  return [
    { label: "Compare base", value: reviewDiff?.compare?.baseBranch ?? "—" },
    { label: "Changed files", value: reviewDiff?.files?.length ?? 0 },
    { label: "Issue count", value: reviewIssues.length },
    { label: "Graph nodes", value: graphDocument?.nodes?.length ?? 0 },
  ];
}

export function getOpenCodeModelLabel(reviewDebug) {
  const model = reviewDebug?.openCode?.model ?? null;
  return model?.providerID && model?.modelID
    ? `${model.providerID}/${model.modelID}`
    : formatDebugValue(model);
}

function summarizeOpenCodePart(part) {
  if (!part || typeof part !== "object") {
    return null;
  }

  const compact = (value) =>
    String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();

  switch (part.type) {
    case "text":
    case "reasoning": {
      const text = String(part.text ?? "").trim();
      return text || null;
    }
    case "tool": {
      const title = compact(part.title);
      const tool = compact(part.tool);
      const state = compact(part.state);
      const output = String(part.output ?? "").trim();
      const error = String(part.error ?? "").trim();
      const body = error || output;
      return [tool || "tool", title || state, body]
        .filter(Boolean)
        .join(body ? "\n" : " · ");
    }
    case "step-start":
      return "Started a new review step.";
    case "step-finish":
      return compact(part.reason)
        ? `Finished step · ${compact(part.reason)}`
        : "Finished step.";
    case "subtask":
      return [
        compact(part.agent),
        compact(part.description),
        compact(part.prompt),
      ]
        .filter(Boolean)
        .join(" · ");
    case "agent":
      return compact(part.name)
        ? `Using agent ${compact(part.name)}`
        : "Using an agent.";
    case "retry":
      return compact(part.attempt)
        ? `Retry ${compact(part.attempt)}`
        : "Retrying.";
    case "file":
      return compact(part.filename) || compact(part.url) || "Attached a file.";
    default:
      return null;
  }
}

export function getOpenCodeLiveEntries(reviewDebug, limit = null) {
  const messages = reviewDebug?.openCode?.messages ?? [];
  const entries = [];

  messages.forEach((message, messageIndex) => {
    (message.parts ?? []).forEach((part, partIndex) => {
      const summary = summarizeOpenCodePart(part);
      if (!summary) {
        return;
      }

      entries.push({
        id: `${message.id ?? messageIndex}:${part.id ?? partIndex}`,
        role: message.role ?? "assistant",
        type: part.type ?? "unknown",
        summary,
        createdAt: message.createdAt ?? part.createdAt ?? null,
      });
    });
  });

  return typeof limit === "number" ? entries.slice(-limit) : entries;
}

export function formatRelativeTime(value) {
  if (!value) {
    return "just now";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "just now";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
