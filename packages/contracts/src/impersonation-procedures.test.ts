import { describe, expect, it } from "vitest";
import { IMPERSONATION_PROCEDURE_KIND } from "./impersonation-procedures.js";
import { appContract } from "./rpc.js";

function contractProcedurePaths(
  node: unknown,
  prefix: readonly string[] = [],
): readonly string[] {
  if (!node || typeof node !== "object") return [];
  if (Object.prototype.hasOwnProperty.call(node, "~orpc")) {
    return [prefix.join(".")];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    contractProcedurePaths(child, [...prefix, key]),
  );
}

describe("IMPERSONATION_PROCEDURE_KIND", () => {
  it("classifies every appContract procedure path exactly once", () => {
    const contractPaths = new Set(contractProcedurePaths(appContract));
    const tablePaths = new Set(Object.keys(IMPERSONATION_PROCEDURE_KIND));

    const missing = [...contractPaths].filter((path) => !tablePaths.has(path)).sort();
    const unknown = [...tablePaths].filter((path) => !contractPaths.has(path)).sort();

    expect({ missing, unknown }).toEqual({ missing: [], unknown: [] });
    expect(tablePaths.size).toBe(contractPaths.size);
  });

  it("marks only read, write, or ops kinds", () => {
    for (const kind of Object.values(IMPERSONATION_PROCEDURE_KIND)) {
      expect(["read", "write", "ops"]).toContain(kind);
    }
  });
});
