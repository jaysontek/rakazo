// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallState } from "../../lib/call-session";
import { endCall } from "../../lib/call-session";
import { CallCard } from "./CallCard";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  NativeSelect: ({ children, ...props }: { children: ReactNode }) => (
    <select {...props}>{children}</select>
  ),
  NativeSelectOption: ({ children, ...props }: { children: ReactNode }) => (
    <option {...props}>{children}</option>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { name: "Ada", email: "a@test" } } }) },
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    voice: {
      status: { queryOptions: () => ({}), queryKey: () => ["voice-status"] },
      voices: { queryOptions: () => ({}) },
    },
  }),
}));
vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => ({ voice: { setVoice: vi.fn() } }) }));
vi.mock("./CallStrip", () => ({
  CallStrip: () => <div data-testid="call-view" />,
}));
let routeBotId: string | undefined;
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ botId: routeBotId }),
}));
let session: CallState | null = null;
vi.mock("../../lib/call-session", () => ({
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  useCallSession: () => session,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let composer: HTMLTextAreaElement;

function render(call: Partial<CallState> | null) {
  session = call
    ? ({
        botId: "bot-1",
        botName: "Test bot",
        phase: "listening",
        exchanges: [],
        ...call,
      } as CallState)
    : null;
  act(() => root.render(<CallCard onSettings={vi.fn()} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  routeBotId = undefined;
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  composer.focus();
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  vi.unstubAllGlobals();
});

it("hides the floating dock on the matching bot thread", () => {
  routeBotId = "bot-1";
  render({});
  expect(container.querySelector('[data-testid="call-view"]')).toBeNull();
});

it("shows a compact top dock when away from the called bot", () => {
  routeBotId = "other";
  render({});
  const dock = container.querySelector('[data-testid="call-view"]')?.parentElement;
  expect(dock).not.toBeNull();
  expect(dock?.className).toContain("top-0");
  expect(dock?.className).not.toContain("bottom-0");
});

it("hangs up on Escape without covering the composer", () => {
  routeBotId = "other";
  render({});
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(endCall).toHaveBeenCalledOnce();
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
});
