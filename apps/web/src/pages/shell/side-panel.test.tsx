// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

vi.mock("../../components/ImpersonationReadOnlyNotice", () => ({
  ImpersonationReadOnlyNotice: () => (
    <p data-testid="impersonation-read-only-notice">Read-only while viewing as Ada</p>
  ),
}));

vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => <div data-testid="computer-maintenance" />,
}));

vi.mock("../../components/pages/PagesList", () => ({
  PagesList: () => null,
}));

vi.mock("../ResizableSidePanel", () => ({
  ResizableSidePanel: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div data-testid="side-panel">{children}</div> : null,
}));

vi.mock("../GroupPanel", () => ({
  CreateGroupForm: () => <div data-testid="create-group-form" />,
  GroupSettings: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="group-settings">
      {readOnly ? <p data-testid="impersonation-read-only-notice">notice</p> : null}
    </div>
  ),
}));

vi.mock("./agent-import", () => ({
  AgentImportForm: () => <div data-testid="agent-import" />,
}));

vi.mock("./bot-panel", () => ({
  BotSettings: ({
    onTabChange,
    readOnly,
  }: {
    onTabChange?: (tab: string) => void;
    readOnly?: boolean;
  }) => (
    <div data-testid="bot-settings">
      {readOnly ? <p data-testid="impersonation-read-only-notice">notice</p> : null}
      <button data-testid="tab-computer" type="button" onClick={() => onTabChange?.("computer")}>
        Computer
      </button>
      <button data-testid="tab-routines" type="button" onClick={() => onTabChange?.("routines")}>
        Routines
      </button>
      <button data-testid="tab-pages" type="button" onClick={() => onTabChange?.("pages")}>
        Pages
      </button>
      <button data-testid="tab-advanced" type="button" onClick={() => onTabChange?.("settings")}>
        Advanced
      </button>
    </div>
  ),
}));

vi.mock("../RoutineEditor", () => ({
  RoutineEditor: () => <div data-testid="routine-editor" />,
}));

vi.mock("../../lib/thread-events", () => ({
  computerPanelNeedsMaintenance: () => false,
}));

import { ShellSidePanel } from "./side-panel";

const bot = {
  id: "bot-1",
  name: "Ada",
  computerMode: "off",
} as never;

function baseProps(overrides: Partial<ComponentProps<typeof ShellSidePanel>> = {}) {
  return {
    rpc: {} as never,
    panel: "settings" as const,
    setPanel: vi.fn(),
    active: bot,
    activeGroup: undefined,
    bots: [bot],
    groups: [],
    setBots: vi.fn(),
    setGroups: vi.fn(),
    navigate: vi.fn(),
    refreshBots: async () => undefined,
    refreshThread: async () => ({}) as never,
    refreshGroupThread: async () => ({}) as never,
    computer: null,
    computerOpen: false,
    booting: false,
    computerPanel: null,
    routinesPanel: null,
    routineEditorProps: null,
    openBot: vi.fn(),
    openCreatedBot: vi.fn(),
    modelFocusRequest: 0,
    openSettings: vi.fn(),
    memoryProviderConfigured: false,
    setAgentSkills: vi.fn(),
    onClearBot: vi.fn(),
    discardChatAttachments: vi.fn(),
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderPanel(props: Partial<ComponentProps<typeof ShellSidePanel>> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ShellSidePanel {...baseProps(props)} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ShellSidePanel readOnly", () => {
  it("shows the notice and keeps bot tab triggers interactive while impersonating", async () => {
    await renderPanel({ readOnly: true });
    expect(host!.querySelector('[data-testid="impersonation-read-only-notice"]')).not.toBeNull();
    expect(host!.querySelector("fieldset[disabled]")).toBeNull();
    expect(host!.querySelector('[data-testid="bot-settings"]')).not.toBeNull();
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="tab-computer"]')?.disabled).toBe(
      false,
    );
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="tab-routines"]')?.disabled).toBe(
      false,
    );
  });

  it("forwards bot tab changes while readOnly", async () => {
    const setPanel = vi.fn();
    await renderPanel({ readOnly: true, setPanel });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="tab-computer"]')?.click();
    });
    expect(setPanel).toHaveBeenCalledWith("computer");
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="tab-routines"]')?.click();
    });
    expect(setPanel).toHaveBeenCalledWith("routines");
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="tab-pages"]')?.click();
    });
    expect(setPanel).toHaveBeenCalledWith("pages");
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="tab-advanced"]')?.click();
    });
    expect(setPanel).toHaveBeenCalledWith("settings");
  });

  it("does not show the notice when not impersonating", async () => {
    await renderPanel({ readOnly: false });
    expect(host!.querySelector('[data-testid="impersonation-read-only-notice"]')).toBeNull();
    expect(host!.querySelector("fieldset[disabled]")).toBeNull();
    expect(host!.querySelector('[data-testid="bot-settings"]')).not.toBeNull();
  });
});
