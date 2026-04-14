import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotCollectionError } from "../errors.js"
import type { TReviewScope } from "../config/review-scope.js"
import {
  resolveReviewCompare,
  type TReviewCompare,
} from "../schemas/review-range.js"

export type TCollectedFileState = "changed" | "affected" | "unchanged"

export type TCollectedFile = {
  path: string
  basename: string
  excerpt: string
  gitStatus: string | null
  changeType: "modified" | "added" | "deleted" | "renamed" | "untracked" | null
  state: TCollectedFileState
  impactSources: string[]
  impactReasons: string[]
  consumerPaths: string[]
}

export type TRepoSnapshot = {
  repoPath: string
  repoName: string
  readme: string | null
  packageJson: string | null
  compare: TReviewCompare
  gitStatusSummary: string | null
  recentCommits: string[]
  fileTree: string[]
  files: TCollectedFile[]
  changedFiles: string[]
  impactedFiles: string[]
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".py",
  ".sh",
  ".yml",
  ".yaml",
  ".css",
  ".html",
])

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const IGNORED_DIRS = new Set([".git", "node_modules", "dist"])
const MAX_FILE_TREE_ENTRIES: Record<TReviewScope, number> = {
  branch: 80,
  repo: 180,
}
const MAX_REPRESENTATIVE_FILES: Record<TReviewScope, number> = {
  branch: 16,
  repo: 24,
}
const MAX_README_LENGTH = 4000
const MAX_PACKAGE_JSON_LENGTH = 2000
const MAX_FILE_EXCERPT_LENGTH = 900

function isInterfaceReviewableFile(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/")
  const basename = path.posix.basename(normalizedPath)
  const extension = path.posix.extname(normalizedPath)

  if (!CODE_EXTENSIONS.has(extension)) {
    return false
  }

  if (/(^|\/)\.openreview(?:-[^/]+)?\//u.test(normalizedPath)) {
    return false
  }

  if (/(^|\/)(tests?|__tests__|fixtures?|__mocks__|mocks?)(\/|$)/u.test(normalizedPath)) {
    return false
  }

  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(basename)) {
    return false
  }

  if (/(^|\/)(.*\.)?config\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(normalizedPath)) {
    return false
  }

  if (/(^|\/)config\//u.test(normalizedPath)) {
    return false
  }

  return true
}

function isIgnoredDirName(dirName: string): boolean {
  return IGNORED_DIRS.has(dirName) || dirName.startsWith(".openreview")
}

async function safeReadText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
}

async function safeStat(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listFiles(root: string, limit = 260): Promise<string[]> {
  const results: string[] = []
  const queue = [root]

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()
    if (!current) continue

    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (isIgnoredDirName(entry.name)) continue

      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(absolutePath)
        continue
      }

      if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        continue
      }

      results.push(path.relative(root, absolutePath).replaceAll("\\", "/"))
      if (results.length >= limit) break
    }
  }

  return results.sort()
}

async function expandChangedPath({
  repoPath,
  rawPath,
}: {
  repoPath: string
  rawPath: string
}): Promise<string[]> {
  const absolutePath = path.join(repoPath, rawPath)

  try {
    const stats = await fs.stat(absolutePath)
    if (!stats.isDirectory()) {
      return [rawPath.replaceAll("\\", "/")]
    }

    const nestedFiles = await listFiles(absolutePath, 400)
    return nestedFiles.map((nestedPath) => path.posix.join(rawPath.replaceAll("\\", "/"), nestedPath))
  } catch {
    return [rawPath.replaceAll("\\", "/")]
  }
}

async function runGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileAsync = promisify(execFile)
    const result = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 1024 * 1024 * 8,
    })
    return result.stdout.trim()
  } catch {
    return null
  }
}

function buildExcerpt(content: string | null, maxLength = 1600): string {
  return content ? content.slice(0, maxLength) : ""
}

function trimText(content: string | null, maxLength: number): string | null {
  if (!content) {
    return null
  }

  return content.length > maxLength ? `${content.slice(0, maxLength)}\n…` : content
}

function mapGitStatusToChangeType(status: string | null): TCollectedFile["changeType"] {
  if (!status) return null
  if (status.includes("??")) return "untracked"
  if (status.includes("R")) return "renamed"
  if (status.includes("A")) return "added"
  if (status.includes("D")) return "deleted"
  return "modified"
}

function getCriticalImpactReasons(filePath: string): string[] {
  const reasons: string[] = []
  const basename = path.basename(filePath)

  if (["package.json", "tsconfig.json", "README.md"].includes(basename)) {
    reasons.push("repo-critical")
  }
  if (filePath.startsWith("bin/")) {
    reasons.push("entrypoint")
  }
  if (filePath.startsWith("src/") && basename.startsWith("index.")) {
    reasons.push("barrel-file")
  }

  return reasons
}

function getFileDepth(filePath: string): number {
  return filePath.split("/").length
}

function scoreRepositoryFile({
  filePath,
  changedStatuses,
  impactedFiles,
  graph,
}: {
  filePath: string
  changedStatuses: Map<string, string>
  impactedFiles: Map<string, { impactSources: Set<string>; impactReasons: Set<string> }>
  graph: TGraph
}): number {
  const basename = path.posix.basename(filePath)
  const impactReasons = getCriticalImpactReasons(filePath)
  const consumerCount = graph.incoming.get(filePath)?.size ?? 0
  const dependencyCount = graph.outgoing.get(filePath)?.size ?? 0
  const depthBonus = Math.max(0, 10 - getFileDepth(filePath)) * 2
  const entrypointBonus =
    basename.startsWith("index.") || basename.startsWith("main.") ||
    basename.startsWith("client.") || basename.startsWith("server.") ||
    basename.startsWith("app.") || basename.startsWith("api.")
      ? 25
      : 0

  return (
    (changedStatuses.has(filePath) ? 200 : 0) +
    (impactedFiles.has(filePath) ? 120 : 0) +
    consumerCount * 24 +
    dependencyCount * 6 +
    impactReasons.reduce((acc, reason) => {
      if (reason === "repo-critical") return acc + 90
      if (reason === "entrypoint") return acc + 70
      if (reason === "barrel-file") return acc + 45
      return acc
    }, 0) +
    entrypointBonus +
    depthBonus
  )
}

function extractRelativeImports({
  filePath,
  content,
  fileSet,
}: {
  filePath: string
  content: string
  fileSet: Set<string>
}): string[] {
  const directory = path.posix.dirname(filePath)
  const matches = [
    ...content.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/g),
    ...content.matchAll(/import\(["'](\.[^"']+)["']\)/g),
    ...content.matchAll(/require\(["'](\.[^"']+)["']\)/g),
  ]
  const resolved = new Set<string>()

  for (const match of matches) {
    const rawTarget = match[1]
    if (!rawTarget) continue

    const candidateBase = path.posix.normalize(path.posix.join(directory, rawTarget))
    const candidateWithoutExtension = candidateBase.replace(
      /\.(?:[mc]?js|jsx|ts|tsx)$/u,
      "",
    )
    const possibilities = [
      candidateBase,
      candidateWithoutExtension,
      `${candidateWithoutExtension}.ts`,
      `${candidateWithoutExtension}.tsx`,
      `${candidateWithoutExtension}.js`,
      `${candidateWithoutExtension}.jsx`,
      `${candidateWithoutExtension}.mjs`,
      `${candidateWithoutExtension}.cjs`,
      `${candidateBase}.ts`,
      `${candidateBase}.tsx`,
      `${candidateBase}.js`,
      `${candidateBase}.jsx`,
      `${candidateBase}.mjs`,
      `${candidateBase}.cjs`,
      `${candidateWithoutExtension}/index.ts`,
      `${candidateWithoutExtension}/index.tsx`,
      `${candidateWithoutExtension}/index.js`,
      `${candidateWithoutExtension}/index.jsx`,
      `${candidateWithoutExtension}/index.mjs`,
      `${candidateWithoutExtension}/index.cjs`,
      `${candidateBase}/index.ts`,
      `${candidateBase}/index.tsx`,
      `${candidateBase}/index.js`,
      `${candidateBase}/index.jsx`,
      `${candidateBase}/index.mjs`,
      `${candidateBase}/index.cjs`,
    ]

    for (const possibility of possibilities) {
      if (fileSet.has(possibility)) {
        resolved.add(possibility)
        break
      }
    }
  }

  return [...resolved]
}

type TGraph = {
  outgoing: Map<string, Set<string>>
  incoming: Map<string, Set<string>>
}

async function buildImportGraph({
  repoPath,
  fileTree,
}: {
  repoPath: string
  fileTree: string[]
}): Promise<TGraph> {
  const fileSet = new Set(fileTree)
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()

  for (const relativePath of fileTree) {
    if (!CODE_EXTENSIONS.has(path.extname(relativePath))) continue
    const content = await safeReadText(path.join(repoPath, relativePath))
    if (!content) continue

    const imports = extractRelativeImports({
      filePath: relativePath,
      content,
      fileSet,
    })

    outgoing.set(relativePath, new Set(imports))
    for (const importedPath of imports) {
      const dependents = incoming.get(importedPath) ?? new Set<string>()
      dependents.add(relativePath)
      incoming.set(importedPath, dependents)
    }
  }

  return { outgoing, incoming }
}

async function collectChangedFiles({
  repoPath,
  compare,
}: {
  repoPath: string
  compare: TReviewCompare
}): Promise<Map<string, string>> {
  const changedStatuses = new Map<string, string>()
  const statusOutput = await runGit(repoPath, ["status", "--short"])
  const resolvedBaseBranch = compare.baseBranch
  const resolvedHeadBranch = compare.headBranch ?? "HEAD"

  for (const line of (statusOutput ?? "").split("\n")) {
    if (!line.trim()) continue
    const match = line.match(/^(..?)\s+(.*)$/)
    const status = match?.[1]?.trim() || "??"
    const rawPath = match?.[2]?.split(" -> ").at(-1)?.trim()
    if (!rawPath) continue
    for (const expandedPath of await expandChangedPath({ repoPath, rawPath })) {
      changedStatuses.set(expandedPath, status)
    }
  }

  const diffBaseCandidates = resolvedBaseBranch ? [resolvedBaseBranch] : ["origin/main", "main", "HEAD~1"]
  for (const candidate of diffBaseCandidates) {
    const diffOutput = await runGit(repoPath, ["diff", "--name-status", `${candidate}...${resolvedHeadBranch}`])
    if (diffOutput === null) continue

    let didRecordDiff = false

    for (const line of diffOutput.split("\n")) {
      const [rawStatus, ...rawPathParts] = line.trim().split(/\s+/)
      const rawPath = rawPathParts.at(-1)
      if (!rawStatus || !rawPath) continue
      didRecordDiff = true
      if (!changedStatuses.has(rawPath)) {
        changedStatuses.set(rawPath, rawStatus)
      }
    }

    if (didRecordDiff || resolvedBaseBranch) {
      break
    }
  }

  return changedStatuses
}

function collectImpactedFiles({
  fileTree,
  changedStatuses,
  graph,
}: {
  fileTree: string[]
  changedStatuses: Map<string, string>
  graph: TGraph
}): Map<string, { impactSources: Set<string>; impactReasons: Set<string> }> {
  const impacted = new Map<string, { impactSources: Set<string>; impactReasons: Set<string> }>()
  const changedFiles = [...changedStatuses.keys()].filter(isInterfaceReviewableFile)

  for (const changedFile of changedFiles) {
    const markImpacted = (targetPath: string, reason: string) => {
      if (!isInterfaceReviewableFile(targetPath)) {
        return
      }

      if (changedStatuses.has(targetPath) || targetPath === changedFile) {
        return
      }

      const entry = impacted.get(targetPath) ?? {
        impactSources: new Set<string>(),
        impactReasons: new Set<string>(),
      }
      entry.impactSources.add(changedFile)
      entry.impactReasons.add(reason)
      impacted.set(targetPath, entry)
    }

    for (const dependentPath of graph.incoming.get(changedFile) ?? []) {
      markImpacted(dependentPath, "imported-by")
    }

    const changedDir = path.posix.dirname(changedFile)
    for (const filePath of fileTree) {
      if (filePath === changedFile) continue
      if (path.posix.dirname(filePath) !== changedDir) continue
      const basename = path.posix.basename(filePath)
      if (basename.startsWith("index.") || basename.includes("config")) {
        markImpacted(filePath, "same-subsystem")
      }
    }
  }

  for (const filePath of fileTree) {
    for (const reason of getCriticalImpactReasons(filePath)) {
      if (changedStatuses.has(filePath)) continue
      const entry = impacted.get(filePath) ?? {
        impactSources: new Set<string>(),
        impactReasons: new Set<string>(),
      }
      entry.impactReasons.add(reason)
      impacted.set(filePath, entry)
    }
  }

  return impacted
}

export async function collectRepoSnapshot({
  repoPath,
  scope = "branch",
  compare,
}: {
  repoPath: string
  scope?: TReviewScope
  compare?: Partial<TReviewCompare> | null
}): Promise<TRepoSnapshot> {
  const resolvedRepoPath = path.resolve(repoPath)
  if (!(await safeStat(resolvedRepoPath))) {
    throw new SnapshotCollectionError("Repository path does not exist", {
      repoPath: resolvedRepoPath,
    })
  }

  const repoName = path.basename(resolvedRepoPath)
  const fileLimit = MAX_FILE_TREE_ENTRIES[scope]
  const readmePath = path.join(resolvedRepoPath, "README.md")
  const packageJsonPath = path.join(resolvedRepoPath, "package.json")
  const fileTree = await listFiles(resolvedRepoPath, fileLimit)
  const gitStatusSummary = await runGit(resolvedRepoPath, ["status", "--short"])
  const currentBranch = await runGit(resolvedRepoPath, ["branch", "--show-current"])
  const recentCommitsRaw = await runGit(resolvedRepoPath, ["log", "--format=%h %s", "-5"])
  const recentCommits = recentCommitsRaw ? recentCommitsRaw.split("\n").filter(Boolean) : []
  const hasWorktreeChanges = Boolean(gitStatusSummary?.trim())
  const currentBranchName = currentBranch?.trim() || null
  const normalizedCompare = resolveReviewCompare(compare, {
    headBranch: hasWorktreeChanges ? "HEAD" : currentBranch?.trim() || null,
  })
  const resolvedCompare = hasWorktreeChanges && normalizedCompare.headBranch === currentBranchName
    ? {
        ...normalizedCompare,
        headBranch: "HEAD",
      }
    : normalizedCompare
  const changedStatuses = await collectChangedFiles({
    repoPath: resolvedRepoPath,
    compare: resolvedCompare,
  })
  const graph = await buildImportGraph({ repoPath: resolvedRepoPath, fileTree })
  const impactedFiles = collectImpactedFiles({
    fileTree,
    changedStatuses,
    graph,
  })
  const changedCodeFiles = [...changedStatuses.keys()].filter(isInterfaceReviewableFile)

  const candidatePaths =
    scope === "repo"
      ? new Set(fileTree.filter(isInterfaceReviewableFile))
      : new Set<string>([...changedCodeFiles, ...impactedFiles.keys()])
  const rankedPaths = [...candidatePaths]
    .filter((filePath) => isInterfaceReviewableFile(filePath) && fileTree.includes(filePath))
    .sort((left, right) => {
      if (scope === "branch") {
        const leftChanged = changedStatuses.has(left)
        const rightChanged = changedStatuses.has(right)
        if (leftChanged !== rightChanged) {
          return leftChanged ? -1 : 1
        }
        const leftImpacted = impactedFiles.has(left)
        const rightImpacted = impactedFiles.has(right)
        if (leftImpacted !== rightImpacted) {
          return leftImpacted ? -1 : 1
        }
      }

      const scoreDelta =
        scoreRepositoryFile({ filePath: right, changedStatuses, impactedFiles, graph }) -
        scoreRepositoryFile({ filePath: left, changedStatuses, impactedFiles, graph })
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return left.localeCompare(right)
    })
    .slice(0, MAX_REPRESENTATIVE_FILES[scope])

  const files = await Promise.all(
    rankedPaths.map(async (relativePath) => {
      const content = await safeReadText(path.join(resolvedRepoPath, relativePath))
      const impacted = impactedFiles.get(relativePath)
      const gitStatus = changedStatuses.get(relativePath) ?? null
      return {
        path: relativePath,
        basename: path.basename(relativePath),
        excerpt: buildExcerpt(content, MAX_FILE_EXCERPT_LENGTH),
        gitStatus,
        changeType: mapGitStatusToChangeType(gitStatus),
        state: changedStatuses.has(relativePath)
          ? "changed"
          : impacted
            ? "affected"
            : "unchanged",
        impactSources: impacted ? [...impacted.impactSources].sort() : [],
        impactReasons: impacted ? [...impacted.impactReasons].sort() : [],
        consumerPaths: [...(graph.incoming.get(relativePath) ?? [])]
          .filter(isInterfaceReviewableFile)
          .sort(),
      } satisfies TCollectedFile
    }),
  )

  return {
    repoPath: resolvedRepoPath,
    repoName,
    readme: trimText(await safeReadText(readmePath), MAX_README_LENGTH),
    packageJson: trimText(await safeReadText(packageJsonPath), MAX_PACKAGE_JSON_LENGTH),
    compare: resolvedCompare,
    gitStatusSummary,
    recentCommits,
    fileTree,
    files,
    changedFiles: changedCodeFiles.sort(),
    impactedFiles: [...impactedFiles.keys()].sort(),
  }
}
