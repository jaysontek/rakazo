// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => <span data-testid="bot-avatar" />,
  GroupAvatar: () => <span data-testid="group-avatar" />,
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Collapsible: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-open={open}>{children}</div>
  ),
  CollapsibleTrigger: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { ArchivedChats } from "./archived-chats";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const bot = {
  id: "bot-1",
  name: "Ada",
  color: "#000",
  avatarSet: "default",
  status: "idle",
} as never;

async function renderArchived(readOnly = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ArchivedChats
        archivedBots={[bot]}
        archivedGroups={[]}
        showSpaceSearch={false}
        rpc={
          {
            bots: { restore: vi.fn() },
            groups: { restore: vi.fn() },
          } as never
        }
        refreshBots={async () => undefined}
        setDeleteTarget={vi.fn()}
        setDeleteGroupTarget={vi.fn()}
        readOnly={readOnly}
      />,
    );
  });
  // Open the archived section.
  const trigger = host!.querySelector("button");
  if (trigger) await act(async () => trigger.click());
}

beforeEach(() => {
  host = null;
  root = null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ArchivedChats", () => {
  it("hides Restore and Delete while readOnly", async () => {
    await renderArchived(true);
    expect(host!.textContent).toContain("Ada");
    expect(host!.textContent).not.toContain("Restore");
    expect(host!.textContent).not.toContain("Delete");
  });

  it("shows Restore and Delete when not readOnly", async () => {
    await renderArchived(false);
    expect(host!.textContent).toContain("Restore");
    expect(host!.textContent).toContain("Delete");
  });
});
