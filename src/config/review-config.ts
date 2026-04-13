export type TReviewModel = {
  providerID: string
  modelID: string
}

export type TReviewConfig = {
  baseUrl: string
  agent: string
  model: TReviewModel
  outputDirName: string
}

export const DEFAULT_REVIEW_CONFIG: TReviewConfig = {
  baseUrl: process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
  agent: process.env.OPENREVIEW_AGENT ?? "build",
  model: {
    providerID: process.env.OPENREVIEW_PROVIDER_ID ?? "openai",
    modelID: process.env.OPENREVIEW_MODEL_ID ?? "gpt-5.4",
  },
  outputDirName: ".openreview",
}

export function resolveReviewConfig(partial: Partial<TReviewConfig> = {}): TReviewConfig {
  return {
    baseUrl: partial.baseUrl ?? DEFAULT_REVIEW_CONFIG.baseUrl,
    agent: partial.agent ?? DEFAULT_REVIEW_CONFIG.agent,
    model: partial.model ?? DEFAULT_REVIEW_CONFIG.model,
    outputDirName: partial.outputDirName ?? DEFAULT_REVIEW_CONFIG.outputDirName,
  }
}
