import type { TRepoSnapshot } from "../collectors/repo-snapshot.js";

export function buildReviewPrompt({
  snapshot,
}: {
  snapshot: TRepoSnapshot;
}): string {
  const changedCodeFiles = snapshot.files
    .filter((file) => file.state === "changed")
    .map((file) => `- ${file.path}`);
  const affectedCodeFiles = snapshot.files
    .filter((file) => file.state === "affected")
    .map((file) => `- ${file.path}`);

  return [
    `Review the repository ${snapshot.repoName}.`,
    "Return structured JSON only.",
    "Use git and targeted file reads as needed to understand the relevant code changes.",
    "The output must include an overview and file insights.",
    "This is not a bug-finding pass. Focus on interfaces that future contributors can extend, reuse, and understand quickly.",
    "Review code interfaces for functions and shared callable entrypoints.",
    "Review only actual code files in this branch. Ignore package.json, lockfiles, README, tsconfig, generated output, test-only files, and config-only files unless they directly change a callable function interface.",
    changedCodeFiles.length > 0
      ? ["Changed code files in scope:", ...changedCodeFiles].join("\n")
      : "Changed code files in scope: none identified.",
    affectedCodeFiles.length > 0
      ? ["Affected code files for caller context:", ...affectedCodeFiles].join(
          "\n",
        )
      : "",
    "Focus only on functions whose callable interface changed on this branch.",
    "Only report functions that are exported, consumed by other files, or otherwise act as shared entrypoints. Ignore internal helpers unless they are directly imported elsewhere.",
    "A changed signature includes changed parameters, changed parameter meaning, changed return shape, changed side-effect contract, or changed required call order visible to callers.",
    "If a function's implementation changed but callers still use it the same way, do not report it.",
    "Use these interface principles: name by intent, keep parameter lists short, avoid flag arguments, make side effects obvious, separate distinct behaviors, prefer explicit types over primitive soup, return the main result callers need, avoid provider-specific interface leakage, prefer rigid API layers, remove hardcoded type-specific behavior from shared entrypoints, and make extension paths obvious without overengineering one-off registries.",
    "Actively look for interface sprawl: if 3-4 methods all do versions of the same consumer job, recommend one clear entrypoint instead of many near-duplicates.",
    "Bias toward the simplest consumer model: the best interface is often 'call one function' rather than 'choose among several overlapping methods'.",
    "Treat this as a core question in every finding: 'Are these separate methods actually different jobs, or are they just four ways to do the same thing?' If they are the same job, recommend one function.",
    "A good better-interface suggestion should help a future contributor add a new capability, provider, kind, or caller without rewriting existing call sites.",
    "Only return the highest-leverage results. Fewer, better insights are preferred over broad coverage.",
    "For each important changed function, structure the reasoning as: old interface -> current interface -> should this combine with sibling entrypoints? -> 2-3 better interface options, with migration notes for callers.",
    "Each better interface must be concrete: name the exact function, the current signature or callable shape, and a better signature or split.",
    "When you fill before, current, better, or suggestion.better, prefer raw code signatures or short code blocks only — not prose summaries around them.",
    "Good: `resolveWorkspaceLaunch({ forwardedArgs, worktreePath? }): { argv: string[]; commandString: string }`. Bad: 'Replace applyPromptAgentDefaults plus buildWorkspaceLaunchCommand with one consumer-facing function...'",
    "Good: `applyPromptAgentDefaults({ args }): string[]`. Bad: 'appends default prompt skills into --prompt values and implicitly adds --agent orchestrator...'",
    "Do not emit generic runtime-path, dependency, or contract warnings without naming the exact function and a better interface.",
    "Prefer one primary simplification per finding rather than mixing multiple unrelated fixes together.",
    "When several methods differ only by source type, flags, minor variants, or naming, prefer recommending one entrypoint with a clearer input object over separate methods.",
    "If no exported/shared function signature changed in a file, omit that file from the results.",
    "Example of a bad finding: 'Define one clear contract.'",
    "Example of a good finding: 'Replace submitReview(input, opts?) with createReview(input) and validateReviewInput(input) so callers stop toggling behavior with flags.'",
    "Example of extensibility guidance: 'Replace provider-specific arguments with a provider-agnostic input object so adding a new provider does not change every call site.'",
    "Example of consolidation guidance: 'Replace createAlbumFromFiles(files), createAlbumFromUrls(urls), createAlbumDraft(input), and saveAlbumDraft(input) with one createAlbum(input) entrypoint plus small internal helpers so consumers only have one way to create an album.'",
    "Another good consolidation frame: 'These four methods all create or update the same album concept. Collapse them into one consumer-facing function and push the variant handling behind that boundary.'",
    "",
    "For the overview:",
    "- reviewSummary = the plain-English takeaway about the branch's shared interface changes",
    "- interfacePatterns = the design patterns or extension patterns that matter in this repo",
    "- keyModules = the main files or boundaries where shared interfaces live",
    "",
    "For each returned file insight:",
    "- return at most 4 file insights total",
    "- only include files where this branch changed an exported/shared function signature or materially changed its caller-visible contract",
    "- moduleBoundary = a short plain-English label for the module or shared boundary this file defines",
    "- interfaceSummary = what future contributors should understand first about the shared interfaces in this file",
    "- branchChange = old interface -> current interface in one concise sentence",
    "- callerImpact = which callers depend on this interface and how the current shape helps or slows them down",
    "- extensibilitySummary = what about the current interface helps or hurts future extension and reuse",
    "- interfaceTags = 1-4 concrete tags such as long-parameter-list, flag-argument, hardcoded-kind, provider-leak, hidden-side-effect, ambiguous-name, primitive-soup, mixed-responsibility, or weak-extension-point",
    "- suggestedDirection = the highest-leverage direction for making this file's shared interfaces easier to extend and use",
    "- functionFindings = 1-3 concrete function-level findings in this file",
    "- only emit functionFindings for exported/shared functions changed on this branch or directly affected shared entrypoints with a caller-visible contract change; otherwise return functionFindings = []",
    "",
    "For each functionFindings entry:",
    "- functionName = exact function or method name",
    "- location = repository-relative path and line if possible",
    "- before = the materially different prior interface when one exists, as code only; otherwise use `no materially different prior interface found`",
    "- current = the current signature or callable interface on this branch, as code only",
    "- current must reflect a caller-visible interface change, not an internal refactor",
    "- simplificationStrategy = combine when overlapping entrypoints should become one function because they serve the same consumer job; otherwise split, trim, rename, or stabilize",
    "- combineWith = the sibling methods/functions that should fold into one consumer-facing function; [] when no consolidation is needed",
    "- problem = the main caller-facing problem",
    "- whyConfusing = 1-3 short bullets explaining why callers may misuse or misunderstand it",
    "- consumerImpact = who calls it and why the current interface is costly or risky for them",
    "- better = the recommended option's concrete better signature, split, or caller contract, as code only",
    "- whyBetter = why the recommended option will be easier to extend, reuse, or understand later",
    "- when simplificationStrategy = combine, better should usually show the single consolidated function callers should use",
    "- when simplificationStrategy = combine, explain why callers should no longer need to choose between near-duplicate methods",
    "- suggestions = 2-3 concrete options ordered from recommended to more invasive",
    "- suggestions[0] must match better/whyBetter",
    "- each suggestion must include: label, better, whyBetter, tradeoff",
    "- every suggestion.better must be code only, not a prose sentence",
    "- suggestion labels should be simple and useful, e.g. Smallest change, Clear split, Bolder redesign",
    "- at least one suggestion should be the smallest safe change; another can be a cleaner long-term architecture change if justified",
    "- migrationNotes = practical call-site migration steps or compatibility notes",
    "- priority = critical, high, medium, or low based on caller impact",
    "- fixPrompt = a concise implementation prompt for simplifying this exact function interface",
    '- summarySource must always be exactly "same-prompt-openCode"',
  ].join("\n");
}
