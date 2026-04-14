import type { TRepoSnapshot } from "../collectors/repo-snapshot.js";

export function buildRepoReviewPrompt({
  snapshot,
}: {
  snapshot: TRepoSnapshot;
}): string {
  const worktreeStatusLines = (snapshot.gitStatusSummary ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 20);

  const representativeFiles = snapshot.files
    .slice()
    .sort((left, right) => {
      const leftScore =
        (left.state === "changed" ? 200 : 0) +
        (left.state === "affected" ? 100 : 0) +
        left.consumerPaths.length * 20 +
        left.impactReasons.length * 10;
      const rightScore =
        (right.state === "changed" ? 200 : 0) +
        (right.state === "affected" ? 100 : 0) +
        right.consumerPaths.length * 20 +
        right.impactReasons.length * 10;
      return rightScore - leftScore || left.path.localeCompare(right.path);
    })
    .map((file) => {
      const consumers = file.consumerPaths.slice(0, 6).join(", ");
      return `- ${file.path}${consumers ? ` → ${consumers}` : ""}`;
    })
    .slice(0, 18);

  const interfaceBackboneFiles = snapshot.fileTree
    .filter((filePath) =>
      /(^|\/)(index|main|app|server|client|api|router|types|entry)\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(
        filePath,
      ),
    )
    .slice(0, 20)
    .map((filePath) => `- ${filePath}`);

  return [
    `Review the repository ${snapshot.repoName} as a whole.`,
    "This is a holistic interface review, not a branch-diff review.",
    "Return structured JSON only.",
    "Focus on the repository's current shared interface posture: the entrypoints, modules, and contracts that many callers depend on or that most strongly shape future extension.",
    "Use git and targeted file reads as needed, but do not limit yourself to changed files.",
    "The output must include an overview and file insights.",
    snapshot.gitStatusSummary
      ? "This review may still include uncommitted worktree changes, but treat them as one signal among many rather than the center of the review."
      : "",
    "Treat branchChange as the current interface posture and the most important current-vs-better direction. In repo mode, describe what the interface currently does and what it should become, even when there is no branch diff to compare.",
    "Use a consumer-first lens: prioritize what downstream callers, importers, routes, jobs, services, or UI surfaces need to know when these interfaces change.",
    "Review code interfaces for exported functions, class methods, module entrypoints, shared helpers, and public APIs.",
    "Prefer representative shared-interface files over local implementation details.",
    representativeFiles.length > 0
      ? ["Representative shared-interface files in scope:", ...representativeFiles].join(
          "\n",
        )
      : "Representative shared-interface files in scope: none identified.",
    interfaceBackboneFiles.length > 0
      ? ["Likely interface backbone files:", ...interfaceBackboneFiles].join("\n")
      : "",
    worktreeStatusLines.length > 0
      ? ["Git status summary:", ...worktreeStatusLines].join("\n")
      : "",
    "Focus only on the highest-leverage interface issues. Fewer, better insights are preferred over broad coverage.",
    "A good finding should name the exact function or module boundary, the current shape, and a concrete better interface or consolidation direction.",
    "If several sibling functions or methods appear to do the same consumer job, call out whether they should collapse into one clear entrypoint.",
    "Use these interface principles: name by intent, keep parameter lists short, avoid flag arguments, make side effects obvious, separate distinct behaviors, prefer explicit types over primitive soup, return the main result callers need, avoid provider-specific interface leakage, prefer rigid API layers, and make extension paths obvious without overengineering one-off registries.",
    "When you fill before, current, better, or suggestion.better, prefer raw code signatures or short code blocks only — not prose summaries around them.",
    "For the overview:",
    "- reviewSummary = the plain-English takeaway about the repository's shared interface posture",
    "- interfacePatterns = the design patterns or extension patterns that matter in this repo",
    "- keyModules = the main files or boundaries where shared interfaces live",
    "",
    "For each returned file insight:",
    "- return at most 4 file insights total",
    "- prioritize files with the highest consumer count, entrypoint role, or broad shared-interface pressure",
    "- moduleBoundary = a short plain-English label for the module or shared boundary this file defines",
    "- interfaceSummary = what future contributors should understand first about the shared interfaces in this file",
    "- branchChange = the current interface posture -> the better direction in one concise sentence",
    "- callerImpact = which callers depend on this interface and how the current shape helps or slows them down",
    "- extensibilitySummary = what about the current interface helps or hurts future extension and reuse",
    "- interfaceTags = 1-4 concrete tags such as long-parameter-list, flag-argument, hardcoded-kind, provider-leak, hidden-side-effect, ambiguous-name, primitive-soup, mixed-responsibility, overlapping-entrypoints, or weak-extension-point",
    "- suggestedDirection = the highest-leverage direction for making this file's shared interfaces easier to extend and use",
    "- functionFindings = 1-3 concrete function-level findings in this file",
    "- only emit functionFindings for exported/shared functions or shared entrypoints that shape repo-wide interface quality",
    "",
    "For each functionFindings entry:",
    "- functionName = exact function or method name",
    "- location = repository-relative path and line if possible",
    "- before = the materially different prior interface when one exists, as code only; otherwise use `no materially different prior interface found`",
    "- current = the current signature or callable interface on this branch, as code only",
    "- simplificationStrategy = combine when overlapping entrypoints should become one function because they serve the same consumer job; otherwise split, trim, rename, or stabilize",
    "- combineWith = the sibling methods/functions that should fold into one consumer-facing function; [] when no consolidation is needed",
    "- problem = the main caller-facing problem",
    "- whyConfusing = 1-3 short bullets explaining why callers may misuse or misunderstand it",
    "- consumerImpact = who calls it and why the current interface is costly or risky for them",
    "- better = the recommended option's concrete better signature, split, or caller contract, as code only",
    "- whyBetter = why the recommended option will be easier to extend, reuse, or understand later",
    "- suggestions = 2-3 concrete options ordered from recommended to more invasive",
    "- migrationNotes = practical call-site migration steps or compatibility notes",
    "- priority = critical, high, medium, or low based on caller impact",
    "- fixPrompt = a concise implementation prompt for simplifying this exact function interface",
    '- summarySource must always be exactly "same-prompt-openCode"',
  ].join("\n");
}
