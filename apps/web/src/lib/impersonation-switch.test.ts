// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("./auth", () => ({ authClient: { $store: { notify } } }));

import {
  clearImpersonationLocalState,
  hardSwitchImpersonation,
} from "./impersonation-switch";
import {
  clearImpersonationTeammates,
  IMPERSONATION_ORG_ID_KEY,
  IMPERSONATION_TEAMMATES_KEY,
  storeImpersonationTeammates,
} from "./impersonation-teammates";

describe("clearImpersonationLocalState", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    notify.mockClear();
  });

  it("clears space selection and user-scoped rakazo keys", () => {
    localStorage.setItem("rakazo:space-id", "space-a");
    localStorage.setItem("rakazo:org-spaces", JSON.stringify({ org: "space-a" }));
    localStorage.setItem("rakazo.composerDraft.bot:bot-1", "hello");
    localStorage.setItem("rakazo.composerBindings.bot:bot-1", "{}");
    localStorage.setItem("rakazo:collapsed-sidebar-sections:user-1", "[]");
    localStorage.setItem("rakazo:onboarding-first-bot", "1");
    localStorage.setItem("rakazo:right-panel-state:user-a:space-a:bot:bot-a", "{}");
    localStorage.setItem("rakazo.signedInUser", "user-a");
    localStorage.setItem("rakazo:referral", "CODE");
    localStorage.setItem("rakazo:bots-sidebar-collapsed:user-a", "1");

    clearImpersonationLocalState();

    expect(localStorage.getItem("rakazo:space-id")).toBeNull();
    expect(localStorage.getItem("rakazo:org-spaces")).toBeNull();
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBeNull();
    expect(localStorage.getItem("rakazo.composerBindings.bot:bot-1")).toBeNull();
    expect(localStorage.getItem("rakazo:collapsed-sidebar-sections:user-1")).toBeNull();
    expect(localStorage.getItem("rakazo:onboarding-first-bot")).toBeNull();
    expect(localStorage.getItem("rakazo:right-panel-state:user-a:space-a:bot:bot-a")).toBeNull();
    expect(localStorage.getItem("rakazo.signedInUser")).toBeNull();
    expect(localStorage.getItem("rakazo:referral")).toBeNull();
    expect(localStorage.getItem("rakazo:bots-sidebar-collapsed:user-a")).toBeNull();
  });

  it("keeps locale, appearance, and other account-agnostic prefs", () => {
    localStorage.setItem("rakazo.uiLocale", "de");
    localStorage.setItem("rakazo.uiAppearance", "light");
    localStorage.setItem("rakazo.composerEnterToSend", "0");
    localStorage.setItem("rakazo.showToolActivity", "on");
    localStorage.setItem("rakazo.botsSidebarDensity", "compact");
    localStorage.setItem("rakazo.loadRemoteImages", "on");
    localStorage.setItem("rakazo.responseStreaming", "on");
    localStorage.setItem("rakazo.installPrompt.dismissed", "1");
    localStorage.setItem("rakazo.signed-in-before", "1");
    localStorage.setItem("rakazo:artifacts-view-mode", "list");
    localStorage.setItem("rakazo:right-panel-width", "420");
    localStorage.setItem("unrelated", "keep");

    clearImpersonationLocalState();

    expect(localStorage.getItem("rakazo.uiLocale")).toBe("de");
    expect(localStorage.getItem("rakazo.uiAppearance")).toBe("light");
    expect(localStorage.getItem("rakazo.composerEnterToSend")).toBe("0");
    expect(localStorage.getItem("rakazo.showToolActivity")).toBe("on");
    expect(localStorage.getItem("rakazo.botsSidebarDensity")).toBe("compact");
    expect(localStorage.getItem("rakazo.loadRemoteImages")).toBe("on");
    expect(localStorage.getItem("rakazo.responseStreaming")).toBe("on");
    expect(localStorage.getItem("rakazo.installPrompt.dismissed")).toBe("1");
    expect(localStorage.getItem("rakazo.signed-in-before")).toBe("1");
    expect(localStorage.getItem("rakazo:artifacts-view-mode")).toBe("list");
    expect(localStorage.getItem("rakazo:right-panel-width")).toBe("420");
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});

describe("hardSwitchImpersonation", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    notify.mockClear();
  });

  it("clears space-id, empties the query client, notifies session, and reloads", () => {
    localStorage.setItem("rakazo:space-id", "space-a");
    localStorage.setItem("rakazo.composerDraft.bot:x", "draft");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], { userId: "admin" });
    const assign = vi.fn();

    hardSwitchImpersonation({ queryClient, target: "/app", assign });

    expect(localStorage.getItem("rakazo:space-id")).toBeNull();
    expect(localStorage.getItem("rakazo.composerDraft.bot:x")).toBeNull();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("$sessionSignal");
    expect(assign).toHaveBeenCalledWith("/app");
  });

  it("clears stored teammates only when stopping", () => {
    storeImpersonationTeammates("org-1", [
      { userId: "u1", name: "Ada", email: "ada@example.com" },
    ]);
    const queryClient = new QueryClient();
    const assign = vi.fn();

    hardSwitchImpersonation({ queryClient, assign });
    expect(sessionStorage.getItem(IMPERSONATION_ORG_ID_KEY)).toBe("org-1");
    expect(sessionStorage.getItem(IMPERSONATION_TEAMMATES_KEY)).toBeTruthy();

    hardSwitchImpersonation({
      queryClient,
      target: "/admin/ops",
      clearTeammates: true,
      assign,
    });
    expect(sessionStorage.getItem(IMPERSONATION_ORG_ID_KEY)).toBeNull();
    expect(sessionStorage.getItem(IMPERSONATION_TEAMMATES_KEY)).toBeNull();
    expect(assign).toHaveBeenLastCalledWith("/admin/ops");
  });
});

describe("impersonation teammates storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips teammates and clears them", () => {
    storeImpersonationTeammates("org-9", [
      { userId: "a", name: "A", email: "a@x.com" },
      { userId: "b", name: "B", email: "b@x.com" },
    ]);
    clearImpersonationTeammates();
    expect(sessionStorage.getItem(IMPERSONATION_ORG_ID_KEY)).toBeNull();
  });
});
