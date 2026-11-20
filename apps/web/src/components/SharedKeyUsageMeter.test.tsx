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

// HoverCard/Progress pull Base UI hooks that disagree with this suite's React copies.
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/ui-web")>();
  return {
    ...actual,
    HoverCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    HoverCardTrigger: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    HoverCardContent: () => null,
    Progress: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ProgressTrack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ProgressIndicator: () => null,
    Button: ({ children, ...props }: { children?: ReactNode }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
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

  it("sets aria-valuenow to 100 when blocked by low headroom and shows the headroom notice", () => {
    render({
      kind: "shared_weekly",
      percentUsed: 50,
      usedPercent: 100,
      reservedPercent: 25,
      spentPercent: 50,
      status: "blocked",
      hardStopped: false,
      resetsAt: "2026-11-16T05:00:00.000Z",
      timezone: "America/New_York",
    });
    const bar = container.querySelector(
      '[data-testid="shared-key-usage-meter"] [role="progressbar"]',
    );
    expect(bar?.getAttribute("aria-valuenow")).toBe("100");
    const notice = container.querySelector('[data-testid="shared-key-usage-blocked"]');
    expect(notice?.textContent).toBe("Not enough left for a new run");
    expect(container.textContent).not.toMatch(/\$/);
  });

  it("keeps the hard-stop notice when the allotment is fully used", () => {
    render({
      kind: "shared_weekly",
      percentUsed: 100,
      usedPercent: 100,
      reservedPercent: 0,
      spentPercent: 100,
      status: "blocked",
      hardStopped: true,
      resetsAt: "2026-11-16T05:00:00.000Z",
      timezone: "America/New_York",
    });
    const notice = container.querySelector('[data-testid="shared-key-usage-blocked"]');
    expect(notice?.textContent).toMatch(/Weekly limit reached for new runs/);
    expect(notice?.textContent).toMatch(/Resets/);
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
