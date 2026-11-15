import { describe, expect, it } from "vitest";
import { IMPERSONATION_PROCEDURE_KIND } from "./impersonation-procedures.js";

/**
 * Procedures that look like reads but perform side effects under view-only
 * impersonation (DB writes / wake-lease / decrypt / external provider / shared
 * state). They must stay classified as write so the deny-by-default guard
 * blocks them while impersonating.
 *
 * Keep this list in sync when adding handlers that mutate shared state under a
 * "get/list/preview/probe/url" name.
 */
export const IMPERSONATION_SIDE_EFFECT_PROCEDURES = [
  "capabilities.pluginPreview",
  "computer.downloadFile",
  "computer.readFile",
  "computer.screenUrl",
  "computer.terminalUrl",
  "connections.tools",
  "externalConversations.updatePolicy",
  "models.probeCatalog",
  "models.probeOpenAiCompatible",
] as const;

describe("impersonation read side-effect audit", () => {
  it("classifies known side-effectful procedures as write", () => {
    for (const path of IMPERSONATION_SIDE_EFFECT_PROCEDURES) {
      expect(
        IMPERSONATION_PROCEDURE_KIND[path],
        `${path} must be write (side effects)`,
      ).toBe("write");
    }
  });

  it("does not allow any audited side-effect procedure as read", () => {
    const reads = Object.entries(IMPERSONATION_PROCEDURE_KIND)
      .filter(([, kind]) => kind === "read")
      .map(([path]) => path);
    for (const path of IMPERSONATION_SIDE_EFFECT_PROCEDURES) {
      expect(reads).not.toContain(path);
    }
  });
});
