import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

function getModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getViewerSourcePath(): string {
  return path.resolve(getModuleDir(), "../app/runtime.ts");
}

export function getViewerBundleOutputPaths(): string[] {
  const moduleDir = getModuleDir();
  const outputPaths = [path.resolve(moduleDir, "../assets/viewer-app.bundle.js")];

  if (!moduleDir.includes(`${path.sep}dist${path.sep}`)) {
    outputPaths.push(
      path.resolve(moduleDir, "../../dist/viewer/assets/viewer-app.bundle.js"),
    );
  }

  return Array.from(new Set(outputPaths));
}

export async function buildViewerBundle(): Promise<string> {
  const result = await build({
    entryPoints: [getViewerSourcePath()],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    charset: "utf8",
    legalComments: "none",
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error("OpenReview failed to build the viewer bundle.");
  }

  return outputFile.text;
}

export async function writeViewerBundle(): Promise<string[]> {
  const viewerBundle = await buildViewerBundle();
  const outputPaths = getViewerBundleOutputPaths();

  await Promise.all(
    outputPaths.map(async (outputPath) => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, viewerBundle, "utf8");
    }),
  );

  return outputPaths;
}

export async function ensureViewerBundle(): Promise<string> {
  for (const outputPath of getViewerBundleOutputPaths()) {
    try {
      return await fs.readFile(outputPath, "utf8");
    } catch {
      // Try the next location before building a fresh bundle.
    }
  }

  const viewerBundle = await buildViewerBundle();
  await Promise.all(
    getViewerBundleOutputPaths().map(async (outputPath) => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, viewerBundle, "utf8");
    }),
  );
  return viewerBundle;
}

async function main(): Promise<void> {
  await writeViewerBundle();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
