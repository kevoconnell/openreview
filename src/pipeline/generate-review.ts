import {
  resolveReviewConfig,
  type TReviewConfig,
} from "../config/review-config.js";
import { getReviewOutputDirName, type TReviewScope } from "../config/review-scope.js";
import { collectRepoSnapshot } from "../collectors/repo-snapshot.js";
import { buildReviewPrompt } from "./build-review-prompt.js";
import { buildRepoReviewPrompt } from "./build-repo-review-prompt.js";
import { runStructuredReviewPrompt } from "../opencode/review-client.js";
import {
  ensureRepoOpenCodeServer,
  resolveRepoRoot,
} from "../opencode/server.js";
import {
  REVIEW_DOCUMENT_JSON_SCHEMA,
  ReviewDocumentSchema,
  type TReviewDocument,
} from "../schemas/review.js";
import {
  writeArtifacts,
  writeDebugArtifact,
  type TArtifactPaths,
} from "../outputs/write-artifacts.js";
import type { TReviewCompare } from "../schemas/review-range.js";
import { syncCheckedInViewerAssets } from "../viewer/build/sync-assets.js";

export type TGenerateReviewResult = TArtifactPaths & {
  review: TReviewDocument;
  config: TReviewConfig;
};

export type TGenerateReviewMode = "full" | "incremental";

export async function generateReview({
  repoPath,
  mode = "full",
  scope = "branch",
  config,
  compare,
  promptHint = process.env.OPENREVIEW_PROMPT_HINT ?? "",
  signal,
}: {
  repoPath: string;
  mode?: TGenerateReviewMode;
  scope?: TReviewScope;
  config?: Partial<TReviewConfig>;
  compare?: Partial<TReviewCompare> | null;
  promptHint?: string;
  signal?: AbortSignal;
}): Promise<TGenerateReviewResult> {
  if (scope === "repo" && mode === "incremental") {
    throw new Error("Whole-repo review mode does not support incremental review mode.");
  }

  const resolvedRepoPath = await resolveRepoRoot(repoPath);
  const outputDirName = config?.outputDirName ?? getReviewOutputDirName(scope);
  const baseUrl =
    config?.baseUrl ??
    (await ensureRepoOpenCodeServer({
      repoPath: resolvedRepoPath,
      outputDirName,
    }));
  const resolvedConfig = resolveReviewConfig(
    {
      ...config,
      baseUrl,
      outputDirName,
    },
    scope,
  );
  const snapshot = await collectRepoSnapshot({
    repoPath: resolvedRepoPath,
    scope,
    ...(compare !== undefined ? { compare } : {}),
  });
  const prompt = scope === "repo" ? buildRepoReviewPrompt({ snapshot }) : buildReviewPrompt({ snapshot });
  const promptText = [
    scope === "repo"
      ? `${prompt}\n\nWhole-repo mode: assess the repository's current interface posture across representative shared entrypoints and module boundaries. Do not limit findings to changed files.`
      : mode === "incremental"
        ? `${prompt}\n\nIncremental mode: prioritize recently changed architecture surfaces and interface/contract impact. Do not over-index on superficial diff hygiene.`
        : prompt,
    promptHint.trim()
      ? `Additional review direction:\n${promptHint.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const promptResult = await runStructuredReviewPrompt<TReviewDocument>({
    config: resolvedConfig,
    directory: snapshot.repoPath,
    prompt: promptText,
    schema: REVIEW_DOCUMENT_JSON_SCHEMA,
    ...(signal ? { signal } : {}),
    onSessionDebugUpdate: async (sessionDebug) => {
      await writeDebugArtifact({
        repoPath: snapshot.repoPath,
        config: resolvedConfig,
        prompt: promptText,
        snapshot,
        openCode: sessionDebug,
      });
    },
  });
  const review = ReviewDocumentSchema.parse(promptResult.structuredOutput);

  const artifacts = await writeArtifacts({
    repoPath: snapshot.repoPath,
    config: resolvedConfig,
    review,
    snapshot,
    prompt: promptText,
    openCode: promptResult.sessionDebug,
  });
  await syncCheckedInViewerAssets({
    repoPath: snapshot.repoPath,
    outputDirName: resolvedConfig.outputDirName,
  });

  return {
    ...artifacts,
    review,
    config: resolvedConfig,
  };
}
