// @ts-nocheck

function hasControlPort(controlPort) {
  return typeof controlPort === "number" && controlPort > 0;
}

function buildControlUrl(controlPort, pathname) {
  return `http://127.0.0.1:${controlPort}${pathname}`;
}

function normalizeControlToken(controlToken) {
  return typeof controlToken === "string" && controlToken ? controlToken : null;
}

function normalizeReviewBranchName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeReviewCompare(compare) {
  if (compare == null) {
    return null;
  }

  if (!compare || typeof compare !== "object" || Array.isArray(compare)) {
    throw new Error(
      "Reexamine compare must be an object with baseBranch and headBranch.",
    );
  }

  if (Object.hasOwn(compare, "compareBranch")) {
    throw new Error(
      "Reexamine compare must use baseBranch instead of compareBranch.",
    );
  }

  const normalizedCompare = {
    baseBranch: normalizeReviewBranchName(compare.baseBranch),
    headBranch: normalizeReviewBranchName(compare.headBranch),
  };

  if (!normalizedCompare.baseBranch && !normalizedCompare.headBranch) {
    return null;
  }

  return normalizedCompare;
}

function normalizeReviewScope(scope) {
  return scope === "repo" || scope === "branch" ? scope : null;
}

function normalizeControlBinding({ controlPort, controlToken } = {}) {
  return {
    controlPort: hasControlPort(controlPort) ? controlPort : null,
    controlToken: normalizeControlToken(controlToken),
  };
}

function buildControlHeaders({
  controlToken,
  headers = {},
  includeJson = false,
} = {}) {
  return {
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
    ...(controlToken ? { "X-OpenReview-Control-Token": controlToken } : {}),
    ...headers,
  };
}

async function readControlError(response, fallbackMessage) {
  try {
    const payload = await response.json();
    if (typeof payload?.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Ignore malformed error bodies.
  }

  return fallbackMessage;
}

async function requestWithTimeout(request, pathname, options = {}) {
  const { timeoutMs, signal, ...requestOptions } = options;
  if (!(typeof timeoutMs === "number" && timeoutMs > 0)) {
    return request(pathname, { ...requestOptions, signal });
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await request(pathname, {
      ...requestOptions,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function createViewerControlClient(binding = {}) {
  const resolvedBinding = normalizeControlBinding(binding);
  const isAvailable = () => hasControlPort(resolvedBinding.controlPort);

  const request = (pathname, { method = "GET", headers, body, signal } = {}) =>
    fetch(buildControlUrl(resolvedBinding.controlPort, pathname), {
      method,
      headers,
      body,
      signal,
    });

  const getStatus = async () => {
    if (!isAvailable()) {
      return null;
    }

    const response = await requestWithTimeout(request, "/control/status", {
      method: "GET",
      timeoutMs: 5000,
    });
    if (!response.ok) {
      return null;
    }

    return response.json();
  };

  const resolveControlToken = async () => {
    if (resolvedBinding.controlToken) {
      return resolvedBinding.controlToken;
    }

    try {
      const statusBody = await getStatus();
      const nextToken = statusBody?.sessionDebug?.viewer?.controlToken;
      return normalizeControlToken(nextToken);
    } catch {
      // Ignore token refresh failures and fall through to the request.
      return null;
    }
  };

  const runAction = async (
    pathname,
    {
      method = "POST",
      headers,
      body,
      signal,
      includeJson = false,
      requireAuth = false,
      unavailableMessage = "Viewer control is unavailable while the viewer service is offline.",
      failureMessage,
    } = {},
  ) => {
    if (!isAvailable()) {
      throw new Error(unavailableMessage);
    }

    const response = await request(pathname, {
      method,
      headers: buildControlHeaders({
        controlToken: requireAuth ? await resolveControlToken() : null,
        headers,
        includeJson,
      }),
      body,
      signal,
    });

    if (!response.ok) {
      const fallbackMessage =
        typeof failureMessage === "function"
          ? failureMessage(response.status)
          : failureMessage ?? `Request failed with status ${response.status}.`;
      throw new Error(
        await readControlError(
          response,
          fallbackMessage,
        ),
      );
    }

    return response;
  };

  const actions = {
    async refresh({ mode, compare, scope } = {}) {
      const normalizedCompare = normalizeReviewCompare(compare);
      const normalizedScope = normalizeReviewScope(scope);

      const response = await runAction("/control/refresh", {
        requireAuth: true,
        includeJson: true,
        body: JSON.stringify({
          mode,
          ...(normalizedCompare ? { compare: normalizedCompare } : {}),
          ...(normalizedScope ? { scope: normalizedScope } : {}),
        }),
        unavailableMessage:
          "Viewer refresh is unavailable until the control server is running.",
        failureMessage: (status) => `Viewer refresh failed with status ${status}.`,
      });

      return response.json();
    },
    async hardReset() {
      return actions.refresh({ mode: "full" });
    },
    async reexamine(compare) {
      return actions.refresh({
        mode: "incremental",
        compare,
      });
    },
    async sendFixPrompt({ prompt, files }) {
      const body = Array.isArray(files) ? { prompt, files } : { prompt };
      await runAction("/control/fix-prompt", {
        requireAuth: true,
        includeJson: true,
        body: JSON.stringify(body),
        unavailableMessage:
          "OpenCode handoff is unavailable while the viewer service is offline.",
        failureMessage: (status) => `Fix handoff failed with status ${status}.`,
      });
    },
    async getGitBranches({ signal } = {}) {
      if (!isAvailable()) {
        return {
          branches: [],
          currentBranch: null,
        };
      }

      const response = await runAction("/control/git-branches", {
        method: "GET",
        signal,
        failureMessage: (status) => `Branch fetch failed with status ${status}.`,
      });

      const payload = await response.json();
      return {
        branches: Array.isArray(payload?.branches)
          ? payload.branches
              .map((branch) => String(branch ?? "").trim())
              .filter(Boolean)
          : [],
        currentBranch:
          typeof payload?.currentBranch === "string" &&
          payload.currentBranch.trim()
            ? payload.currentBranch.trim()
            : null,
      };
    },
  };

  return {
    isAvailable,
    getStatus,
    actions,
  };
}
