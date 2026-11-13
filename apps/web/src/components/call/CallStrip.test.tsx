// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallState } from "../../lib/call-session";
import { CallStrip } from "./CallStrip";

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
vi.mock("../../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: { user: { name: "Ada", email: "a@test", image: undefined } } }),
  },
}));
vi.mock("../../lib/space-rpc", () => ({
  useSpaceRpc: () => ({
    voice: {
      status: vi.fn(async () => ({ voiceId: "", provider: null })),
      voices: vi.fn(async () => []),
      setVoice: vi.fn(),
    },
  }),
}));

let session: CallState | null = null;
const getUserMedia = vi.fn();
vi.mock("../../lib/call-session", () => ({
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  useCallSession: () => session,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(call: Partial<CallState> | null) {
  session = call
    ? ({
        botId: "bot-1",
        botName: "Test bot",
        botColor: "#111",
        phase: "listening",
        muted: false,
        exchanges: [],
        ...call,
      } as CallState)
    : null;
  act(() => root.render(<CallStrip onSettings={vi.fn()} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  getUserMedia.mockReset();
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: { getUserMedia },
    permissions: {
      query: vi.fn(async () => ({ state: "granted" })),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders an audio-only call strip with no video element or camera capture", () => {
  render({});
  const view = container.querySelector('[data-testid="call-view"]');
  expect(view).not.toBeNull();
  expect(view?.querySelector("video")).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(view?.querySelector('[aria-label="Mute"]')).not.toBeNull();
  expect(view?.querySelector('[aria-label="Hang up"]')).not.toBeNull();
});

it("shows the account initial instead of a camera preview", () => {
  render({});
  expect(container.textContent).toContain("A");
  expect(container.querySelector("video")).toBeNull();
});
