import { z } from "zod";

export const FunctionSuggestionSchema = z.object({
  label: z.string(),
  better: z.string(),
  whyBetter: z.string(),
  tradeoff: z.string(),
});

export const FunctionFindingSchema = z.object({
  functionName: z.string(),
  location: z.string(),
  before: z.string(),
  current: z.string(),
  simplificationStrategy: z.enum([
    "combine",
    "split",
    "trim",
    "rename",
    "stabilize",
  ]),
  combineWith: z.array(z.string()),
  problem: z.string(),
  whyConfusing: z.array(z.string()),
  consumerImpact: z.string(),
  better: z.string(),
  whyBetter: z.string(),
  suggestions: z.array(FunctionSuggestionSchema).min(2).max(3),
  migrationNotes: z.array(z.string()),
  priority: z.enum(["critical", "high", "medium", "low"]),
  fixPrompt: z.string(),
});

export const FileInsightSchema = z.object({
  path: z.string(),
  basename: z.string(),
  moduleBoundary: z.string(),
  interfaceSummary: z.string(),
  branchChange: z.string(),
  callerImpact: z.string(),
  extensibilitySummary: z.string(),
  suggestedDirection: z.string(),
  interfaceTags: z.array(z.string()),
  functionFindings: z.array(FunctionFindingSchema),
  summarySource: z.literal("same-prompt-openCode"),
});

export const ReviewOverviewSchema = z.object({
  repoName: z.string(),
  projectType: z.string(),
  domain: z.string(),
  reviewSummary: z.string(),
  interfacePatterns: z.array(z.string()),
  keyModules: z.array(z.string()),
});

export const ReviewDocumentSchema = z.object({
  overview: ReviewOverviewSchema,
  files: z.array(FileInsightSchema),
});

export const REVIEW_DOCUMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "files"],
  properties: {
    overview: {
      type: "object",
      additionalProperties: false,
      required: [
        "repoName",
        "projectType",
        "domain",
        "reviewSummary",
        "interfacePatterns",
        "keyModules",
      ],
      properties: {
        repoName: { type: "string", description: "Repository name" },
        projectType: { type: "string", description: "Primary project type" },
        domain: { type: "string", description: "Primary engineering domain" },
        reviewSummary: {
          type: "string",
          description:
            "Concise summary of the branch's most important shared interface changes and why they matter for future contributors",
        },
        interfacePatterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Important interface design patterns or extension patterns present in the repository",
        },
        keyModules: {
          type: "array",
          items: { type: "string" },
          description:
            "Key modules or boundaries where shared callable interfaces live",
        },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "path",
          "basename",
          "moduleBoundary",
          "interfaceSummary",
          "branchChange",
          "callerImpact",
          "extensibilitySummary",
          "suggestedDirection",
          "interfaceTags",
          "functionFindings",
          "summarySource",
        ],
        properties: {
          path: {
            type: "string",
            description: "Repository-relative file path",
          },
          basename: { type: "string", description: "File basename" },
          moduleBoundary: {
            type: "string",
            description:
              "Short label for the module or shared boundary this file defines",
          },
          interfaceSummary: {
            type: "string",
            description:
              "Plain-English summary of the shared interfaces in this file and what future contributors should understand first",
          },
          branchChange: {
            type: "string",
            description:
              "What changed on this branch about the shared callable interface",
          },
          callerImpact: {
            type: "string",
            description:
              "Which callers or consumer files are affected and how the current interface helps or slows them down",
          },
          extensibilitySummary: {
            type: "string",
            description:
              "What about the current interface helps or hurts future extension and reuse",
          },
          suggestedDirection: {
            type: "string",
            description:
              "The highest-leverage direction for simplifying or future-proofing this file's shared interfaces",
          },
          interfaceTags: {
            type: "array",
            items: { type: "string" },
            description:
              "Short tags describing interface issues such as long-parameter-list, flag-argument, hardcoded-kind, provider-leak, hidden-side-effect, ambiguous-name, primitive-soup, mixed-responsibility, overlapping-entrypoints, or weak-extension-point",
          },
          functionFindings: {
            type: "array",
            description:
              "Concrete per-function interface findings for changed shared functions in this file",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "functionName",
                "location",
                "before",
                "current",
                "simplificationStrategy",
                "combineWith",
                "problem",
                "whyConfusing",
                "consumerImpact",
                "better",
                "whyBetter",
                "suggestions",
                "migrationNotes",
                "priority",
                "fixPrompt",
              ],
              properties: {
                functionName: {
                  type: "string",
                  description: "Exact function or method name under review",
                },
                location: {
                  type: "string",
                  description:
                    "Repository-relative location for the function, ideally path:line",
                },
                before: {
                  type: "string",
                  description:
                    "The pre-branch or prior signature when it materially differs; otherwise state that no materially different prior interface was found",
                },
                current: {
                  type: "string",
                  description:
                    "Current signature or callable interface as it exists on this branch",
                },
                simplificationStrategy: {
                  type: "string",
                  enum: ["combine", "split", "trim", "rename", "stabilize"],
                  description:
                    "The main simplification move: combine overlapping entrypoints that serve the same consumer job, split mixed responsibilities, trim parameters, rename for intent, or stabilize the contract",
                },
                combineWith: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Other method or function names that appear to do the same consumer job and should likely collapse into the same consumer-facing entrypoint; empty when no consolidation is recommended",
                },
                problem: {
                  type: "string",
                  description:
                    "The main caller-facing problem with the current interface, especially when callers must choose between several similar methods",
                },
                whyConfusing: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "1-3 short reasons the current interface is hard to understand or easy to misuse",
                },
                consumerImpact: {
                  type: "string",
                  description:
                    "Who calls this function and how the current interface burdens or risks those callers",
                },
                better: {
                  type: "string",
                  description:
                    "A concrete better signature, ideally reducing overlapping entrypoints so callers can do one clear function when the behaviors are conceptually the same or belong to the same consumer job",
                },
                whyBetter: {
                  type: "string",
                  description:
                    "Why the proposed interface will be easier to extend, reuse, or understand in the future, especially by reducing duplicate ways to do the same job",
                },
                suggestions: {
                  type: "array",
                  minItems: 2,
                  maxItems: 3,
                  description:
                    "2-3 concrete architecture/interface options ordered from recommended to more invasive",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["label", "better", "whyBetter", "tradeoff"],
                    properties: {
                      label: {
                        type: "string",
                        description:
                          "Short option label such as Smallest change, Clear split, or Bolder redesign",
                      },
                      better: {
                        type: "string",
                        description: "The concrete interface for this option",
                      },
                      whyBetter: {
                        type: "string",
                        description: "Why this option is better for callers",
                      },
                      tradeoff: {
                        type: "string",
                        description: "The main cost or tradeoff of this option",
                      },
                    },
                  },
                },
                migrationNotes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Practical call-site migration steps or compatibility notes",
                },
                priority: {
                  type: "string",
                  enum: ["critical", "high", "medium", "low"],
                  description:
                    "Priority based on how much the current interface harms callers",
                },
                fixPrompt: {
                  type: "string",
                  description:
                    "A concise implementation prompt focused on simplifying this exact function interface, including consolidation when several entrypoints overlap",
                },
              },
            },
          },
          summarySource: {
            type: "string",
            enum: ["same-prompt-openCode"],
            description: "Must always indicate same-prompt generation",
          },
        },
      },
    },
  },
} as const;

export type TFileInsight = z.infer<typeof FileInsightSchema>;
export type TReviewOverview = z.infer<typeof ReviewOverviewSchema>;
export type TReviewDocument = z.infer<typeof ReviewDocumentSchema>;
