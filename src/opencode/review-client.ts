import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { StructuredReviewError } from "../errors.js"
import type { TReviewConfig } from "../config/review-config.js"

export type TOpenCodeSessionDebugPart = {
  type: string
  [key: string]: unknown
}

export type TOpenCodeSessionDebugMessage = {
  id: string
  role: "user" | "assistant"
  createdAt: string
  agent?: string
  model?: string
  provider?: string
  error?: unknown
  parts: TOpenCodeSessionDebugPart[]
}

export type TOpenCodeSessionDebug = {
  sessionId: string
  baseUrl: string
  agent: string
  model: TReviewConfig["model"]
  prompt: string
  finalTextParts: string[]
  messages: TOpenCodeSessionDebugMessage[]
}

async function openEventStream(client: any, signal?: AbortSignal): Promise<any | null> {
  const options = {
    signal,
    sseMaxRetryAttempts: 1,
  }

  if (typeof client?.event?.subscribe === "function") {
    return await client.event.subscribe(options)
  }

  if (typeof client?.event === "function") {
    return await client.event(options)
  }

  if (typeof client?.event?.list === "function") {
    return await client.event.list(options)
  }

  if (typeof client?.global?.event === "function") {
    return await client.global.event(options)
  }

  return null
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null
  }

  const code = "code" in error ? error.code : null
  return typeof code === "string" ? code : null
}

function getErrorCause(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return null
  }

  return "cause" in error ? error.cause : null
}

function isRetryableSessionCreateError(error: unknown): boolean {
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true
  }

  const code = getErrorCode(error)
  if (code && ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return true
  }

  const cause = getErrorCause(error)
  if (cause !== error && cause) {
    return isRetryableSessionCreateError(cause)
  }

  return false
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }

  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("OpenReview generation aborted")
}

async function createSessionWithRetry(client: any, baseUrl: string, signal?: AbortSignal): Promise<any> {
  const retryDelays = [250, 750, 1500]
  const maxAttempts = retryDelays.length + 1
  let lastError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(signal)

    try {
      return await client.session.create({
        ...(signal ? { signal } : {}),
        body: {
          title: "OpenReview interface review",
        },
      })
    } catch (error) {
      lastError = error
      if (!isRetryableSessionCreateError(error) || attempt === maxAttempts - 1) {
        break
      }

      throwIfAborted(signal)
      await sleep(retryDelays[attempt]!)
    }
  }

  throw new StructuredReviewError(`Failed to create OpenCode session at ${baseUrl}: ${formatError(lastError)}`, {
    baseUrl,
    attempts: maxAttempts,
    cause: formatError(lastError),
  }, lastError instanceof Error ? { cause: lastError } : undefined)
}

function maybeParseJsonText(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function getJsonCandidates(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) {
    return []
  }

  const candidates = new Set<string>([trimmed])
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim()
    if (candidate) {
      candidates.add(candidate)
    }
  }

  const firstObjectIndex = trimmed.indexOf("{")
  const lastObjectIndex = trimmed.lastIndexOf("}")
  if (firstObjectIndex !== -1 && lastObjectIndex > firstObjectIndex) {
    candidates.add(trimmed.slice(firstObjectIndex, lastObjectIndex + 1).trim())
  }

  return [...candidates]
}

function parseStructuredCandidate(value: string): unknown {
  for (const candidate of getJsonCandidates(value)) {
    const parsed = maybeParseJsonText(candidate)
    if (parsed) {
      return parsed
    }
  }

  return null
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  return new Date().toISOString()
}

function serializeMessagePart(part: any): TOpenCodeSessionDebugPart {
  switch (part?.type) {
    case "text":
    case "reasoning":
      return {
        type: part.type,
        text: part.text ?? "",
      }
    case "tool":
      return {
        type: part.type,
        tool: part.tool ?? null,
        state: part.state?.status ?? null,
        title: part.state?.title ?? null,
        input: part.state?.input ?? null,
        output: part.state?.output ?? null,
        error: part.state?.error ?? null,
      }
    case "step-start":
      return {
        type: part.type,
        snapshot: part.snapshot ?? null,
      }
    case "step-finish":
      return {
        type: part.type,
        reason: part.reason ?? null,
        cost: part.cost ?? null,
        tokens: part.tokens ?? null,
      }
    case "agent":
      return {
        type: part.type,
        name: part.name ?? null,
      }
    case "file":
      return {
        type: part.type,
        filename: part.filename ?? null,
        url: part.url ?? null,
        source: part.source ?? null,
      }
    case "subtask":
      return {
        type: part.type,
        agent: part.agent ?? null,
        description: part.description ?? null,
        prompt: part.prompt ?? null,
      }
    case "retry":
      return {
        type: part.type,
        attempt: part.attempt ?? null,
        error: part.error ?? null,
      }
    default:
      return {
        type: typeof part?.type === "string" ? part.type : "unknown",
      }
  }
}

function serializeSessionMessage(message: any): TOpenCodeSessionDebugMessage {
  const info = message?.info ?? {}
  const model =
    info?.role === "user"
      ? info?.model?.modelID ?? null
      : info?.role === "assistant"
        ? info?.modelID ?? null
        : null
  const provider =
    info?.role === "user"
      ? info?.model?.providerID ?? null
      : info?.role === "assistant"
        ? info?.providerID ?? null
        : null

  return {
    id: info?.id ?? "unknown",
    role: info?.role === "assistant" ? "assistant" : "user",
    createdAt: toIsoTimestamp(info?.time?.created),
    error: info?.error ?? null,
    parts: Array.isArray(message?.parts) ? message.parts.map(serializeMessagePart) : [],
    ...(typeof info?.agent === "string" ? { agent: info.agent } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof provider === "string" ? { provider } : {}),
  }
}

function getMessageTextParts(message: any): string[] {
  if (!Array.isArray(message?.parts)) {
    return []
  }

  return message.parts
    .filter((part: any) => (part?.type === "text" || part?.type === "reasoning") && typeof part?.text === "string")
    .map((part: any) => part.text.trim())
    .filter(Boolean)
}

function getPromptResponseTextParts(promptResponse: any): string[] {
  return (promptResponse?.data?.parts ?? promptResponse?.parts ?? [])
    .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
    .map((part: any) => part.text)
}

function getAssistantTextParts(messages: any[]): string[] {
  return messages
    .filter((message: any) => message?.info?.role === "assistant")
    .flatMap((message: any) => getMessageTextParts(message))
}

function getEventSessionId(event: any): string | null {
  switch (event?.type) {
    case "message.updated":
      return event?.properties?.info?.sessionID ?? null
    case "message.part.updated":
      return event?.properties?.part?.sessionID ?? null
    case "message.part.removed":
    case "session.status":
    case "session.idle":
    case "todo.updated":
    case "command.executed":
    case "session.diff":
    case "session.error":
      return event?.properties?.sessionID ?? null
    case "session.updated":
      return event?.properties?.info?.id ?? null
    default:
      return null
  }
}

async function readSessionMessages({
  client,
  sessionId,
  signal,
}: {
  client: any
  sessionId: string
  signal?: AbortSignal
}): Promise<any[]> {
  const sessionMessagesResponse: any = await client.session
    .messages({
      path: { id: sessionId },
      ...(signal ? { signal } : {}),
    })
    .catch(() => null)

  if (Array.isArray(sessionMessagesResponse?.data)) {
    return sessionMessagesResponse.data
  }

  if (Array.isArray(sessionMessagesResponse)) {
    return sessionMessagesResponse
  }

  return []
}

function buildSessionDebug({
  sessionId,
  config,
  prompt,
  finalTextParts,
  messages,
}: {
  sessionId: string
  config: TReviewConfig
  prompt: string
  finalTextParts: string[]
  messages: any[]
}): TOpenCodeSessionDebug {
  return {
    sessionId,
    baseUrl: config.baseUrl,
    agent: config.agent,
    model: config.model,
    prompt,
    finalTextParts,
    messages: messages.map(serializeSessionMessage),
  }
}

export async function runOpenCodePrompt({
  config,
  directory,
  prompt,
  onSessionDebugUpdate,
  signal,
}: {
  config: TReviewConfig
  directory?: string
  prompt: string
  onSessionDebugUpdate?: ((sessionDebug: TOpenCodeSessionDebug) => void | Promise<void>) | null
  signal?: AbortSignal
}): Promise<{
  textParts: string[]
  sessionDebug: TOpenCodeSessionDebug
}> {
  throwIfAborted(signal)

  const client: any = createOpencodeClient({
    baseUrl: config.baseUrl,
    throwOnError: true,
    ...(directory ? { directory } : {}),
  })

  const sessionResponse: any = await createSessionWithRetry(client, config.baseUrl, signal)
  const sessionId = sessionResponse?.data?.id ?? sessionResponse?.id
  if (!sessionId) {
    throw new StructuredReviewError("Failed to create OpenCode session")
  }

  let currentFinalTextParts: string[] = []
  const emitSessionDebug = async (): Promise<TOpenCodeSessionDebug> => {
    const messages = await readSessionMessages({
      client,
      sessionId,
      ...(signal ? { signal } : {}),
    })
    const sessionDebug = buildSessionDebug({
      sessionId,
      config,
      prompt,
      finalTextParts: currentFinalTextParts,
      messages,
    })

    if (onSessionDebugUpdate) {
      await onSessionDebugUpdate(sessionDebug)
    }

    return sessionDebug
  }

  if (onSessionDebugUpdate) {
    await onSessionDebugUpdate(
      buildSessionDebug({
        sessionId,
        config,
        prompt,
        finalTextParts: currentFinalTextParts,
        messages: [],
      }),
    )
  }

  try {
    const promptResponse = await client.session.prompt({
      ...(signal ? { signal } : {}),
      path: { id: sessionId },
      body: {
        agent: config.agent,
        model: config.model,
        parts: [{ type: "text", text: prompt }],
      },
    })

    const textParts = getPromptResponseTextParts(promptResponse)
    currentFinalTextParts = textParts

    if (currentFinalTextParts.length === 0) {
      const messages = await readSessionMessages({
        client,
        sessionId,
        ...(signal ? { signal } : {}),
      })
      currentFinalTextParts = getAssistantTextParts(messages)
    }

    const sessionDebug = await emitSessionDebug()

    return {
      textParts: currentFinalTextParts,
      sessionDebug,
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new StructuredReviewError("OpenReview generation aborted", {
        baseUrl: config.baseUrl,
        sessionId,
      }, error instanceof Error ? { cause: error } : undefined)
    }

    throw error
  }
}

export async function runStructuredReviewPrompt<T>({
  config,
  directory,
  prompt,
  schema,
  onSessionDebugUpdate,
  signal,
}: {
  config: TReviewConfig
  directory?: string
  prompt: string
  schema: object
  onSessionDebugUpdate?: ((sessionDebug: TOpenCodeSessionDebug) => void | Promise<void>) | null
  signal?: AbortSignal
}): Promise<{
  structuredOutput: T
  sessionDebug: TOpenCodeSessionDebug
}> {
  throwIfAborted(signal)

  const client: any = createOpencodeClient({
    baseUrl: config.baseUrl,
    throwOnError: true,
    ...(directory ? { directory } : {}),
  })

  const sessionResponse: any = await createSessionWithRetry(client, config.baseUrl, signal)
  const sessionId = sessionResponse?.data?.id ?? sessionResponse?.id
  if (!sessionId) {
    throw new StructuredReviewError("Failed to create OpenCode session")
  }

  let currentFinalTextParts: string[] = []
  const emitSessionDebug = async ({ force = false }: { force?: boolean } = {}): Promise<TOpenCodeSessionDebug> => {
    const messages = await readSessionMessages({
      client,
      sessionId,
      ...(signal ? { signal } : {}),
    })
    const sessionDebug = buildSessionDebug({
      sessionId,
      config,
      prompt,
      finalTextParts: currentFinalTextParts,
      messages,
    })

    if (onSessionDebugUpdate && (force || messages.length > 0)) {
      await onSessionDebugUpdate(sessionDebug)
    }

    return sessionDebug
  }

  if (onSessionDebugUpdate) {
    await onSessionDebugUpdate(
      buildSessionDebug({
        sessionId,
        config,
        prompt,
        finalTextParts: currentFinalTextParts,
        messages: [],
      }),
    )
  }

  const eventAbortController = new AbortController()
  const abortSession = () => {
    eventAbortController.abort()
    void client.session.abort({
      path: { id: sessionId },
    }).catch(() => {
      // Best-effort abort only.
    })
  }

  signal?.addEventListener("abort", abortSession)
  let lastDebugEmitAt = 0
  let emitInFlight = false
  let emitQueued = false
  let emitTimer: ReturnType<typeof setTimeout> | null = null

  const flushSessionDebug = async ({ force = false }: { force?: boolean } = {}) => {
    if (!onSessionDebugUpdate) {
      return
    }

    const now = Date.now()
    if (!force && now - lastDebugEmitAt < 700) {
      if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = null
          void flushSessionDebug({ force: true })
        }, 700 - (now - lastDebugEmitAt))
      }
      return
    }

    if (emitInFlight) {
      emitQueued = true
      return
    }

    emitInFlight = true
    lastDebugEmitAt = Date.now()
    await emitSessionDebug({ force })
    emitInFlight = false

    if (emitQueued) {
      emitQueued = false
      await flushSessionDebug({ force: true })
    }
  }

  const eventTask = onSessionDebugUpdate
    ? (async () => {
        try {
          const eventSource: any = await openEventStream(client, eventAbortController.signal)

          if (!eventSource?.stream) {
            return
          }

          for await (const event of eventSource?.stream ?? []) {
            if (eventAbortController.signal.aborted) {
              break
            }

            if (getEventSessionId(event) !== sessionId) {
              continue
            }

            await flushSessionDebug({ force: event?.type === "session.idle" })
          }
        } catch {
          // Best-effort live stream only.
        } finally {
          if (emitTimer) {
            clearTimeout(emitTimer)
            emitTimer = null
          }
        }
      })()
    : null

  let promptResponse: any = null

  try {
    throwIfAborted(signal)

    promptResponse = await client.session.prompt({
      ...(signal ? { signal } : {}),
      path: { id: sessionId },
      body: {
        agent: config.agent,
        model: config.model,
        parts: [{ type: "text", text: prompt }],
        format: {
          type: "json_schema",
          schema,
          retryCount: 2,
        },
      },
    })

    const textParts = getPromptResponseTextParts(promptResponse)
    currentFinalTextParts = textParts

    let structuredOutput =
      promptResponse?.data?.info?.structured ??
      promptResponse?.info?.structured ??
      promptResponse?.data?.info?.structured_output ??
      promptResponse?.info?.structured_output ??
      textParts.map(parseStructuredCandidate).find(Boolean) ??
      null

    if (!structuredOutput) {
      const messages = await readSessionMessages({ client, sessionId })
      const assistantTextParts = getAssistantTextParts(messages)
      if (assistantTextParts.length > 0) {
        currentFinalTextParts = assistantTextParts
      }
      structuredOutput = assistantTextParts.map(parseStructuredCandidate).find(Boolean) ?? null
    }

    if (!structuredOutput) {
      throw new StructuredReviewError("OpenCode did not return structured output", {
        sessionId,
        response: promptResponse,
        finalTextParts: currentFinalTextParts,
      })
    }

    const sessionDebug = await emitSessionDebug({ force: true })

    return {
      structuredOutput: structuredOutput as T,
      sessionDebug,
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new StructuredReviewError("OpenReview generation aborted", {
        baseUrl: config.baseUrl,
        sessionId,
      }, error instanceof Error ? { cause: error } : undefined)
    }

    throw error
  } finally {
    signal?.removeEventListener("abort", abortSession)
    eventAbortController.abort()
    await eventTask
  }
}
