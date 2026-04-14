export type TReviewScope = "branch" | "repo";

export const DEFAULT_REVIEW_SCOPE: TReviewScope = "branch";

export function getReviewOutputDirName(
  scope: TReviewScope = DEFAULT_REVIEW_SCOPE,
): string {
  return scope === "repo" ? ".openreview-repo" : ".openreview";
}
