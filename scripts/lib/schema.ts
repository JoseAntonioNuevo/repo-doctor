import type { CleanupPlan, RepoReport } from "./types.ts";

export class SchemaError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SchemaError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SchemaError(`${label} must be a string`);
  return value;
}

function versioned(value: unknown, label: string): Record<string, unknown> {
  const root = record(value, label);
  if (root.tool !== "repo-doctor" || root.version !== 2) throw new SchemaError(`${label} must be a repo-doctor version-2 artifact`);
  string(root.toolVersion, `${label}.toolVersion`);
  return root;
}

export function assertRepoReportV2(value: unknown): asserts value is RepoReport {
  const root = versioned(value, "report");
  record(root.source, "report.source");
  record((root.source as Record<string, unknown>).repository, "report.source.repository");
  record(root.scanOptions, "report.scanOptions");
  for (const key of ["ignore", "entries"]) array((root.scanOptions as Record<string, unknown>)[key], `report.scanOptions.${key}`);
  for (const key of ["largeCount", "minDupBytes"]) {
    const value = (root.scanOptions as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(`report.scanOptions.${key} must be a non-negative safe integer`);
  }
  for (const key of ["health", "graph", "totals"]) record(root[key], `report.${key}`);
  array(root.diagnostics, "report.diagnostics");
  array(root.projects, "report.projects");
  array(root.files, "report.files");
  array(root.packages, "report.packages");
  array(root.warnings, "report.warnings");
  string(root.scanOptionsDigest, "report.scanOptionsDigest");
  string((root.source as Record<string, unknown>).inventoryDigest, "report.source.inventoryDigest");
  string((root.source as Record<string, unknown>).indexDigest, "report.source.indexDigest");
}

export function assertCleanupPlanV2(value: unknown): asserts value is CleanupPlan {
  const root = versioned(value, "plan");
  const source = record(root.source, "plan.source");
  for (const key of ["reportSha256", "repositoryId", "inventoryDigest", "indexDigest", "scanOptionsDigest", "toolVersion"]) string(source[key], `plan.source.${key}`);
  const options = record(root.options, "plan.options");
  for (const key of ["keep", "approve", "allowDelete"]) array(options[key], `plan.options.${key}`);
  const confidence = string(options.minConfidence, "plan.options.minConfidence");
  if (!("low" === confidence || "medium" === confidence || "high" === confidence)) throw new SchemaError("plan.options.minConfidence must be low, medium, or high");
  array(root.diagnostics, "plan.diagnostics");
  array(root.protectedFiles, "plan.protectedFiles");
  array(root.items, "plan.items");
  record(root.summary, "plan.summary");
}
