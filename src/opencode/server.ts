import fs from "node:fs/promises"
import { spawnSync } from "node:child_process"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"

type TRepoOpenCodeServerState = {
  pid: number | null
  baseUrl: string
  repoPath: string
  startedAt: string
}

const DEFAULT_OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL?.trim() || "http://localhost:4096"

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function getOutputDir({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string
  outputDirName?: string
}): string {
  return path.join(repoPath, outputDirName)
}

function getRuntimeDir({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string
  outputDirName?: string
}): string {
  return path.join(getOutputDir({ repoPath, outputDirName }), "runtime")
}

function getServerStatePath({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string
  outputDirName?: string
}): string {
  return path.join(getRuntimeDir({ repoPath, outputDirName }), "opencode-server.json")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function runGit(repoPath: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })

    if (result.status !== 0) {
      return null
    }

    const output = result.stdout.trim()
    return output || null
  } catch {
    return null
  }
}

export async function resolveRepoRoot(repoPath: string): Promise<string> {
  const resolvedRepoPath = path.resolve(repoPath)
  const gitRoot = runGit(resolvedRepoPath, ["rev-parse", "--show-toplevel"])
  return gitRoot ? path.resolve(gitRoot) : resolvedRepoPath
}

async function isHealthy(url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const parsedUrl = new URL(url)
    const request = (parsedUrl.protocol === "https:" ? https : http).request(
      parsedUrl,
      {
        method: "GET",
        timeout: 3000,
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
      },
      (response) => {
        response.resume()
        resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300)
      },
    )

    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
    request.end()
  })
}

async function serverMatchesRepo({
  baseUrl,
  repoPath,
}: {
  baseUrl: string
  repoPath: string
}): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const parsedUrl = new URL(`${baseUrl}/path`)
    const request = (parsedUrl.protocol === "https:" ? https : http).request(
      parsedUrl,
      {
        method: "GET",
        timeout: 3000,
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              cwd?: string
              directory?: string
              worktree?: string
            }
            resolve(payload.cwd === repoPath || payload.directory === repoPath || payload.worktree === repoPath)
          } catch {
            resolve(false)
          }
        })
      },
    )

    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
    request.end()
  })
}

async function readServerState({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string
  outputDirName?: string
}): Promise<TRepoOpenCodeServerState | null> {
  const statePath = getServerStatePath({ repoPath, outputDirName })
  if (!(await pathExists(statePath))) {
    return null
  }

  try {
    const content = await fs.readFile(statePath, "utf8")
    if (!content.trim()) {
      return null
    }

    return JSON.parse(content) as TRepoOpenCodeServerState
  } catch {
    return null
  }
}

async function writeServerState({
  repoPath,
  outputDirName = ".openreview",
  state,
}: {
  repoPath: string
  outputDirName?: string
  state: TRepoOpenCodeServerState
}): Promise<void> {
  const runtimeDir = getRuntimeDir({ repoPath, outputDirName })
  const statePath = getServerStatePath({ repoPath, outputDirName })
  await fs.mkdir(runtimeDir, { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await fs.rename(temporaryPath, statePath)
}

function killProcess(pid: number | null): void {
  if (!pid) {
    return
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // Ignore stale or already-exited processes.
  }
}

function parsePort(baseUrl: string): number | null {
  try {
    const parsedUrl = new URL(baseUrl)
    return parsedUrl.port ? Number(parsedUrl.port) : null
  } catch {
    return null
  }
}

function killServerOnPort(port: number | null): void {
  if (!port || !Number.isInteger(port) || port <= 0) {
    return
  }

  try {
    const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const pids = (result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    for (const pid of pids) {
      killProcess(Number.parseInt(pid, 10))
    }
  } catch {
    // Ignore missing lsof or stale ports.
  }
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local OpenCode port")))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })
}

async function startServerAtBaseUrl({
  repoPath,
  outputDirName,
  baseUrl,
}: {
  repoPath: string
  outputDirName: string
  baseUrl: string
}): Promise<string> {
  const port = parsePort(baseUrl) ?? 4096
  const runtimeDir = getRuntimeDir({
    repoPath,
    outputDirName,
  })
  await fs.mkdir(runtimeDir, { recursive: true })
  const logPath = path.join(runtimeDir, "opencode-server.log")
  const launchCommand = [
    "nohup",
    shellQuote(process.env.OPENCODE_PATH ?? "opencode"),
    "serve",
    "--port",
    String(port),
    "--hostname",
    "localhost",
    `>>${shellQuote(logPath)}`,
    "2>&1",
    "</dev/null",
    "&",
    "printf '%s' $!",
  ].join(" ")
  const launchResult = spawnSync("sh", ["-lc", launchCommand], {
    encoding: "utf8",
    cwd: repoPath,
    env: {
      ...process.env,
      OPENCODE_BASE_URL: baseUrl,
    },
  })

  if (launchResult.status !== 0) {
    throw new Error(launchResult.stderr.trim() || `Failed to start OpenCode server at ${baseUrl}`)
  }

  const serverPid = Number.parseInt(launchResult.stdout.trim(), 10)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await isHealthy(`${baseUrl}/global/health`)) {
      await writeServerState({
        repoPath,
        outputDirName,
        state: {
          pid: Number.isFinite(serverPid) ? serverPid : null,
          baseUrl,
          repoPath,
          startedAt: new Date().toISOString(),
        },
      })
      return baseUrl
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  killProcess(Number.isFinite(serverPid) ? serverPid : null)
  killServerOnPort(port)
  throw new Error(`OpenCode server did not become healthy for ${repoPath} at ${baseUrl}/global/health`)
}

export async function ensureRepoOpenCodeServer({
  repoPath,
  outputDirName = ".openreview",
}: {
  repoPath: string
  outputDirName?: string
}): Promise<string> {
  const resolvedRepoPath = await resolveRepoRoot(repoPath)
  const baseUrl = DEFAULT_OPENCODE_BASE_URL
  const defaultPort = parsePort(baseUrl)
  const priorState = await readServerState({
    repoPath: resolvedRepoPath,
    outputDirName,
  })

  if (priorState?.baseUrl && await isHealthy(`${priorState.baseUrl}/global/health`)) {
    if (await serverMatchesRepo({
      baseUrl: priorState.baseUrl,
      repoPath: resolvedRepoPath,
    })) {
      await writeServerState({
        repoPath: resolvedRepoPath,
        outputDirName,
        state: {
          pid: priorState.pid,
          baseUrl: priorState.baseUrl,
          repoPath: resolvedRepoPath,
          startedAt: priorState.startedAt,
        },
      })
      return priorState.baseUrl
    }
  }

  if (await isHealthy(`${baseUrl}/global/health`)) {
    if (await serverMatchesRepo({
      baseUrl,
      repoPath: resolvedRepoPath,
    })) {
      await writeServerState({
        repoPath: resolvedRepoPath,
        outputDirName,
        state: {
          pid: priorState?.baseUrl === baseUrl ? priorState.pid : null,
          baseUrl,
          repoPath: resolvedRepoPath,
          startedAt: priorState?.baseUrl === baseUrl ? priorState.startedAt : new Date().toISOString(),
        },
      })
      return baseUrl
    }

    const fallbackPort = await findAvailablePort()
    return await startServerAtBaseUrl({
      repoPath: resolvedRepoPath,
      outputDirName,
      baseUrl: `http://localhost:${fallbackPort}`,
    })
  }

  killProcess(priorState?.pid ?? null)
  killServerOnPort(parsePort(priorState?.baseUrl ?? ""))
  killServerOnPort(defaultPort)

  return await startServerAtBaseUrl({
    repoPath: resolvedRepoPath,
    outputDirName,
    baseUrl,
  })
}
