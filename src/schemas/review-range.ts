export type TReviewCompare = {
  baseBranch: string | null;
  headBranch: string | null;
};

export function normalizeReviewBranchName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeReviewCompare(
  compare?: Partial<TReviewCompare> | null,
): TReviewCompare {
  return {
    baseBranch: normalizeReviewBranchName(compare?.baseBranch),
    headBranch: normalizeReviewBranchName(compare?.headBranch),
  };
}

export function resolveReviewCompare(
  compare?: Partial<TReviewCompare> | null,
  { headBranch }: { headBranch?: unknown } = {},
): TReviewCompare {
  const normalizedCompare = normalizeReviewCompare(compare);

  return {
    baseBranch: normalizedCompare.baseBranch,
    headBranch:
      normalizedCompare.headBranch ?? normalizeReviewBranchName(headBranch),
  };
}
