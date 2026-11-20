// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../PluginsOverlay", () => ({
  PluginsOverlay: () => <div data-testid="overlay-integrations" />,
}));
vi.mock("../../components/integrations/skills-dialog", () => ({
  SkillsDialog: () => <div data-testid="overlay-skills" />,
}));
vi.mock("../McpServersOverlay", () => ({
  McpServersOverlay: () => <div data-testid="overlay-mcp" />,
}));

const { AppOverlays } = await import("./shell-overlays");

afterEach(() => {
  document.body.replaceChildren();
});

async function render(kind: "integrations" | "skills" | "mcp", readOnly = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Suspense fallback={null}>
        <AppOverlays
          overlay={kind === "mcp" ? { kind: "mcp" } : { kind }}
          setOverlay={() => undefined}
          activeBotId="bot-1"
          stdioEnabled={false}
          onConnectedAppsChange={() => undefined}
          readOnly={readOnly}
        />
      </Suspense>,
    ),
  );
  // Lazy overlays resolve on a microtask.
  await act(async () => await Promise.resolve());
  return { host, root };
}

it("mounts integrations, skills and MCP overlays when writable", async () => {
  for (const kind of ["integrations", "skills", "mcp"] as const) {
    const { host, root } = await render(kind);
    expect(host.querySelector(`[data-testid="overlay-${kind}"]`)).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();
  }
});

it("does not mount integrations, skills or MCP overlays while read-only", async () => {
  for (const kind of ["integrations", "skills", "mcp"] as const) {
    const { host, root } = await render(kind, true);
    expect(host.querySelector(`[data-testid="overlay-${kind}"]`)).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  }
});
