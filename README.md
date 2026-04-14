# openreview

`openreview` generates a repo review for a local project using OpenCode, then writes the results to `.openreview/`.

## What you get

- a review overview at `.openreview/overview.md`
- per-file insights at `.openreview/file-insights.json`
- a CLI for generating, refreshing, and opening review output
- a TypeScript API with `generateReview()` as the main entrypoint

## Requirements

- Node.js + `pnpm`
- an OpenCode server running at `http://127.0.0.1:4096` by default

## Setup

```bash
cd ~/Desktop/openreview
pnpm install
pnpm typecheck
```

## CLI usage

Run from the repo you want to review:

```bash
openreview
```

Useful commands:

```bash
openreview                # generate if needed, then open the overview
openreview refresh        # regenerate review output
openreview generate       # generate review output and print paths
openreview status         # show whether review files already exist
openreview show-overview  # open the generated overview
openreview show-doc <file>
```

Useful flags:

```bash
--local <path>        # review a different local repo
--incremental         # request an incremental review
```

When launched through a package script, `openreview` uses the directory it was originally invoked from.

## Output

All generated files are written to `.openreview/` inside the repo being reviewed.

Primary files:

- `.openreview/overview.md`
- `.openreview/file-insights.json`

## Library usage

```ts
import { generateReview } from "openreview"

const result = await generateReview({
  repoPath: "/path/to/repo",
  mode: "full",
})
```

## Defaults

- OpenCode base URL: `http://127.0.0.1:4096`
- agent: `orchestrator`
- model: `openai/gpt-5.4`

OpenCode transport details stay inside `src/opencode/`, and the filesystem is the system of record for generated review output.
