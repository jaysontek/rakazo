// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  GroupSettings: () => <div data-testid="group-settings" />,
}));

vi.mock("./agent-import", () => ({
  AgentImportForm: () => <div data-testid="agent-import" />,
}));

vi.mock("./bot-panel", () => ({
  BotSettings: () => <div data-testid="bot-settings">Bot settings</div>,
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
  it("shows a disabled fieldset and notice while impersonating", async () => {
    await renderPanel({ readOnly: true });
    expect(host!.querySelector('[data-testid="impersonation-read-only-notice"]')).not.toBeNull();
    expect(host!.querySelector("fieldset[disabled]")).not.toBeNull();
    expect(host!.querySelector('[data-testid="bot-settings"]')).not.toBeNull();
  });

  it("does not wrap BotSettings when not impersonating", async () => {
    await renderPanel({ readOnly: false });
    expect(host!.querySelector('[data-testid="impersonation-read-only-notice"]')).toBeNull();
    expect(host!.querySelector("fieldset[disabled]")).toBeNull();
    expect(host!.querySelector('[data-testid="bot-settings"]')).not.toBeNull();
  });
});
