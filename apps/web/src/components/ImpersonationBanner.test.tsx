// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stopImpersonation = vi.fn();
const switchImpersonation = vi.fn();
const me = vi.fn();
const hardSwitch = vi.fn();

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("../lib/rpc", () => ({
  rpc: {
    me: () => me(),
    ops: {
      stopImpersonation: () => stopImpersonation(),
      switchImpersonation: (...args: unknown[]) => switchImpersonation(...args),
    },
  },
}));

vi.mock("../lib/impersonation-switch", () => ({
  hardSwitchImpersonation: (...args: unknown[]) => hardSwitch(...args),
}));

vi.mock("../lib/impersonation-teammates", () => ({
  readImpersonationOrgId: () => "org-1",
  readImpersonationTeammates: () => [
    { userId: "u1", name: "Ada", email: "ada@example.com" },
    { userId: "u2", name: "Bob", email: "bob@example.com" },
  ],
}));

vi.mock("@rakazo/ui-web", () => ({
  buttonVariants: () => "",
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { ImpersonationBanner } from "./ImpersonationBanner";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderBanner() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Providers>
        <ImpersonationBanner />
      </Providers>,
    );
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (host!.querySelector('[data-testid="impersonation-banner"]')) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  me.mockReset();
  stopImpersonation.mockReset();
  switchImpersonation.mockReset();
  hardSwitch.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ImpersonationBanner", () => {
  it("shows read-only copy with expiry and stop", async () => {
    me.mockResolvedValue({
      impersonating: {
        adminUserId: "admin",
        targetUserId: "u1",
        targetName: "Ada",
        targetEmail: "ada@example.com",
        expiresAt: "2030-06-15T18:30:00.000Z",
        impersonationSessionId: "imp_1_1",
      },
    });
    await renderBanner();
    const banner = host!.querySelector('[data-testid="impersonation-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.className).toContain("bg-destructive/10");
    expect(banner!.textContent).toMatch(/Read-only/);
    expect(banner!.textContent).toMatch(/Ada/);
    expect(banner!.textContent).toMatch(/ada@example.com/);
    expect(banner!.textContent).toMatch(/Ends/);
    expect(host!.querySelector('[data-testid="impersonation-stop"]')).not.toBeNull();
  });

  it("stops with a hard switch back to ops", async () => {
    me.mockResolvedValue({
      impersonating: {
        adminUserId: "admin",
        targetUserId: "u1",
        targetName: "Ada",
        targetEmail: "ada@example.com",
        expiresAt: "2030-06-15T18:30:00.000Z",
        impersonationSessionId: "imp_1_1",
      },
    });
    stopImpersonation.mockResolvedValue({ impersonating: null });
    await renderBanner();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="impersonation-stop"]')!.click();
    });
    expect(stopImpersonation).toHaveBeenCalledOnce();
    expect(hardSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ target: "/admin/ops", clearTeammates: true }),
    );
  });

  it("switches teammates via ops.switchImpersonation", async () => {
    me.mockResolvedValue({
      impersonating: {
        adminUserId: "admin",
        targetUserId: "u1",
        targetName: "Ada",
        targetEmail: "ada@example.com",
        expiresAt: "2030-06-15T18:30:00.000Z",
        impersonationSessionId: "imp_1_1",
      },
    });
    switchImpersonation.mockResolvedValue({ impersonating: { targetUserId: "u2" } });
    await renderBanner();
    const select = host!.querySelector<HTMLSelectElement>('[data-testid="impersonation-switch"]');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = "u2";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(switchImpersonation).toHaveBeenCalledWith({ userId: "u2", organizationId: "org-1" });
    expect(hardSwitch).toHaveBeenCalledWith(expect.objectContaining({ target: "/app" }));
  });
});
