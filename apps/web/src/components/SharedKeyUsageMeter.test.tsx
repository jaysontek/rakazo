// @vitest-environment jsdom
import type { UsageLimit } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ i18n: { locale: "en-US" }, t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("@rakazo/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/core")>();
  return {
    ...actual,
    formatSharedKeyBudgetResetAt: () => "Mon 12:00 AM",
  };
});

import { SharedKeyUsageMeter } from "./SharedKeyUsageMeter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SharedKeyUsageMeter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(limit: UsageLimit) {
    act(() => {
      root.render(<SharedKeyUsageMeter limit={limit} />);
    });
  }

  it("sets aria-valuenow from spent+reserved and shows a blocked notice without dollars", () => {
    render({
      kind: "shared_weekly",
      percentUsed: 50,
      usedPercent: 75,
      reservedPercent: 25,
      spentPercent: 50,
      status: "blocked",
      resetsAt: "2026-11-16T05:00:00.000Z",
      timezone: "America/New_York",
    });
    const bar = container.querySelector(
      '[data-testid="shared-key-usage-meter"] [role="progressbar"]',
    );
    expect(bar?.getAttribute("aria-valuenow")).toBe("75");
    const notice = container.querySelector('[data-testid="shared-key-usage-blocked"]');
    expect(notice?.textContent).toMatch(/Weekly limit reached for new runs/);
    expect(notice?.textContent).toMatch(/Resets/);
    expect(container.textContent).not.toMatch(/\$/);
  });

  it("renders a reserved segment when reservedPercent is set", () => {
    render({
      kind: "shared_weekly",
      percentUsed: 50,
      usedPercent: 75,
      reservedPercent: 25,
      spentPercent: 50,
      status: "ok",
      resetsAt: "2026-11-16T05:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(container.querySelector('[data-testid="shared-key-usage-reserved"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="shared-key-usage-blocked"]')).toBeNull();
  });
});
