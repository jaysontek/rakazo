// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const impersonating = vi.hoisted(() => ({ current: false as boolean }));

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("../lib/use-impersonating", () => ({
  useIsImpersonating: () => impersonating.current,
  useImpersonating: () => null,
}));

vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: { user: { email: "admin@example.com" } } }),
  },
}));

vi.mock("../lib/organizations", () => ({
  useOrganizations: () => ({
    organizations: [
      { id: "org-1", name: "Acme" },
      { id: "org-2", name: "Beta" },
    ],
    activeOrganizationId: "org-1",
  }),
  switchOrganization: vi.fn(),
}));

vi.mock("../lib/query", () => ({
  useQueryUserId: () => "user-1",
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: async () => ({ isAdmin: false }) }) },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { isAdmin: false, impersonating: null } }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div data-testid="account-menu-content">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...props
  }: ComponentProps<"button"> & { children?: ReactNode }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  CircleUserRound: () => null,
}));

vi.mock("./AccountAccess", () => ({
  DeleteAccountForm: () => null,
  hasDeleteRedirectError: () => false,
}));

import { AccountMenu } from "./AccountMenu";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderMenu() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AccountMenu signingOut={false} onLogOut={() => undefined} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  impersonating.current = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AccountMenu", () => {
  it("hides Log out and Delete account while impersonating", async () => {
    impersonating.current = true;
    await renderMenu();
    expect(host!.querySelector('[data-testid="account-menu-log-out"]')).toBeNull();
    expect(host!.querySelector('[data-testid="account-menu-delete-account"]')).toBeNull();
    expect(host!.textContent).not.toContain("Acme");
  });

  it("shows Log out and Delete account when not impersonating", async () => {
    await renderMenu();
    expect(host!.querySelector('[data-testid="account-menu-log-out"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="account-menu-delete-account"]')).not.toBeNull();
  });
});
