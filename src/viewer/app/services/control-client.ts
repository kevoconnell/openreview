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

    const response = await request("/control/status");
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
    async hardReset() {
      await runAction("/control/hard-reset", {
        requireAuth: true,
        unavailableMessage:
          "Hard reset is unavailable until the viewer control server is running.",
        failureMessage: (status) => `Hard reset failed with status ${status}.`,
      });
    },
    async retry() {
      await actions.hardReset();
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
    async reexamine({ baseBranch, headBranch, compareBranch }) {
      await runAction("/control/reexamine", {
        requireAuth: true,
        includeJson: true,
        body: JSON.stringify({
          baseBranch: baseBranch || null,
          headBranch: headBranch || compareBranch || null,
        }),
        unavailableMessage:
          "Reexamine needs the viewer service. Start or refresh OpenReview, then try again.",
        failureMessage: (status) =>
          `Reexamine request failed with status ${status}.`,
      });
    },
  };

  return {
    isAvailable,
    getStatus,
    actions,
  };
}
