export class OpenReviewError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "OpenReviewError"
  }
}

export class SnapshotCollectionError extends OpenReviewError {
  constructor(message: string, context: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, context, options)
    this.name = "SnapshotCollectionError"
  }
}

export class StructuredReviewError extends OpenReviewError {
  constructor(message: string, context: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, context, options)
    this.name = "StructuredReviewError"
  }
}

export class OutputWriteError extends OpenReviewError {
  constructor(message: string, context: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, context, options)
    this.name = "OutputWriteError"
  }
}
