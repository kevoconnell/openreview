import {
  resolveReviewConfig,
  type TReviewConfig,
} from "../config/review-config.js";
import { collectRepoSnapshot } from "../collectors/repo-snapshot.js";
import { buildReviewPrompt } from "./build-review-prompt.js";
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
  config,
  compare,
  promptHint = process.env.OPENREVIEW_PROMPT_HINT ?? "",
  signal,
}: {
  repoPath: string;
  mode?: TGenerateReviewMode;
  config?: Partial<TReviewConfig>;
  compare?: Partial<TReviewCompare> | null;
  promptHint?: string;
  signal?: AbortSignal;
}): Promise<TGenerateReviewResult> {
  const resolvedRepoPath = await resolveRepoRoot(repoPath);
  const baseUrl =
    config?.baseUrl ??
    (await ensureRepoOpenCodeServer({
      repoPath: resolvedRepoPath,
      ...(config?.outputDirName ? { outputDirName: config.outputDirName } : {}),
    }));
  const resolvedConfig = resolveReviewConfig({
    ...config,
    baseUrl,
  });
  const snapshot = await collectRepoSnapshot({
    repoPath: resolvedRepoPath,
    ...(compare !== undefined ? { compare } : {}),
  });
  const prompt = buildReviewPrompt({ snapshot });
  const promptText = [
    mode === "incremental"
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
