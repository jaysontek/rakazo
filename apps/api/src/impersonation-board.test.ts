import { createRouterClient } from "@orpc/server";
import * as adapters from "@rakazo/adapters";
import { appContract, type Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isImpersonationAllowedProcedure } from "./impersonation-allowlist.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const denied = { code: "FORBIDDEN", message: "Not allowed while impersonating" };

const boardRow = {
  id: "board-1",
  spaceId: "space-1",
  name: "Personal",
  ticketPrefix: "RAK",
  nextNumber: 2,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const ticketDto = {
  id: "ticket-1",
  boardId: "board-1",
  spaceId: "space-1",
  number: 1,
  ref: "RAK-1",
  title: "Ship",
  description: null,
  status: "todo" as const,
  priority: "normal" as const,
  assigneeBotId: "bot-1",
  createdByBotId: null,
  createdByUserId: "user-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  completedAt: null,
};

const commentDto = {
  id: "comment-1",
  ticketId: "ticket-1",
  body: "Ready",
  authorBotId: null,
  authorUserId: "user-1",
  authorName: "user",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function boardPrisma() {
  const applied = ({ data }: { data: { name?: string; ticketPrefix?: string } }) => ({
    ...boardRow,
    ...data,
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  });
  return {
    board: {
      findUnique: vi.fn(async () => boardRow),
      findUniqueOrThrow: vi.fn(async () => boardRow),
      findMany: vi.fn(async () => [boardRow]),
      createMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(applied),
      updateManyAndReturn: vi.fn(async (args: { data: { name?: string; ticketPrefix?: string } }) => [
        applied(args),
      ]),
    },
    ticket: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    },
    ticketComment: {
      findMany: vi.fn(async () => []),
    },
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        archivedAt: null,
        thread: null,
        computer: null,
      })),
    },
    space: {
      findUnique: vi.fn(async () => ({ name: "Personal" })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  };
}

function makeDeps(prisma = boardPrisma()) {
  return {
    prisma,
    env: { ticketBoardEnabled: true },
    boardEvents: {
      follow: () => ({
        next: async () => ({ done: true as const, value: undefined }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    },
  } as unknown as RouterDeps;
}

function client(impersonatedBy: string | null, deps = makeDeps()) {
  return createRouterClient(createRouter(deps), {
    context: {
      actor,
      sessionId: "session-1",
      ...(impersonatedBy ? { impersonatedBy } : {}),
    },
  });
}

function contractProcedurePaths(
  node: unknown,
  prefix: readonly string[] = [],
): readonly (readonly string[])[] {
  if (!node || typeof node !== "object") return [];
  if (Object.prototype.hasOwnProperty.call(node, "~orpc")) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    contractProcedurePaths(child, [...prefix, key]),
  );
}

async function invokePath(
  rpc: ReturnType<typeof client>,
  path: readonly string[],
  input?: unknown,
): Promise<unknown> {
  // The router client is a proxy — read properties directly rather than `in`.
  let current: unknown = rpc;
  for (const segment of path) {
    current = (current as Record<string, unknown> | null | undefined)?.[segment];
  }
  if (typeof current !== "function") {
    throw new Error(`Missing client path ${path.join(".")}`);
  }
  return (current as (value?: unknown) => Promise<unknown>)(input);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string | undefined {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : undefined;
}

/**
 * Procedures that intentionally do not sit on `authed` (no actor required).
 * Everything else must be allowlisted or denied while impersonating.
 */
const PUBLIC_PATHS = new Map<string, string>([
  ["health", "Unauthenticated liveness probe built on os, not authed."],
]);

describe("board routes under impersonation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mutations = [
    {
      name: "boards.rename",
      call: (rpc: ReturnType<typeof client>) => rpc.boards.rename({ name: "Launch" }),
    },
    {
      name: "tickets.create",
      call: (rpc: ReturnType<typeof client>) =>
        rpc.tickets.create({ title: "Ship", assigneeBotId: "bot-1" }),
    },
    {
      name: "tickets.update",
      call: (rpc: ReturnType<typeof client>) =>
        rpc.tickets.update({ id: "ticket-1", title: "Ship today" }),
    },
    {
      name: "tickets.move",
      call: (rpc: ReturnType<typeof client>) =>
        rpc.tickets.move({ id: "ticket-1", status: "doing" }),
    },
    {
      name: "tickets.comment",
      call: (rpc: ReturnType<typeof client>) =>
        rpc.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
    },
  ] as const;

  it.each(mutations)("denies $name while impersonating", async ({ call }) => {
    await expect(call(client("admin"))).rejects.toMatchObject(denied);
  });

  it("allows each board/ticket mutation when not impersonating", async () => {
    vi.spyOn(adapters, "createTicket").mockResolvedValue({ ticket: ticketDto });
    vi.spyOn(adapters, "updateTicket").mockResolvedValue({
      ticket: { ...ticketDto, status: "doing" },
    });
    vi.spyOn(adapters, "commentTicket").mockResolvedValue({ comment: commentDto });

    const rpc = client(null);
    await expect(rpc.boards.rename({ name: "Launch" })).resolves.toMatchObject({ name: "Launch" });
    await expect(rpc.tickets.create({ title: "Ship", assigneeBotId: "bot-1" })).resolves.toEqual(
      ticketDto,
    );
    await expect(rpc.tickets.update({ id: "ticket-1", title: "Ship today" })).resolves.toMatchObject(
      { id: "ticket-1" },
    );
    await expect(rpc.tickets.move({ id: "ticket-1", status: "doing" })).resolves.toMatchObject({
      status: "doing",
    });
    await expect(
      rpc.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
    ).resolves.toMatchObject({ id: "comment-1", body: "Ready" });
  });

  it("still allows board reads needed to view while impersonating", async () => {
    const prisma = boardPrisma();
    prisma.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      boardId: "board-1",
      spaceId: "space-1",
      number: 1,
      title: "Ship",
      description: null,
      status: "todo",
      priority: "normal",
      assigneeBotId: "bot-1",
      createdByBotId: null,
      createdByUserId: "user-1",
      createdAt: new Date(ticketDto.createdAt),
      updatedAt: new Date(ticketDto.updatedAt),
      completedAt: null,
    });
    const rpc = client("admin", makeDeps(prisma));
    await expect(rpc.boards.list()).resolves.toEqual([
      expect.objectContaining({ id: "board-1", name: "Personal" }),
    ]);
    await expect(rpc.boards.get()).resolves.toMatchObject({ id: "board-1" });
    await expect(rpc.tickets.list({})).resolves.toEqual({ tickets: [] });
    await expect(rpc.tickets.get({ id: "ticket-1" })).resolves.toMatchObject({
      id: "ticket-1",
      ref: "RAK-1",
    });
    await expect(rpc.tickets.comments({ ticketId: "ticket-1" })).resolves.toEqual([]);
  });
});

describe("impersonation allowlist meta", () => {
  it("keeps PUBLIC_PATHS exactly {health} and truly unauthenticated", async () => {
    expect([...PUBLIC_PATHS.keys()]).toEqual(["health"]);
    const signedOut = createRouterClient(createRouter(makeDeps()), {
      context: { actor: null },
    });
    for (const [dotted, reason] of PUBLIC_PATHS) {
      expect(reason.length).toBeGreaterThan(0);
      const path = dotted.split(".");
      try {
        await invokePath(signedOut, path, {});
      } catch (error) {
        expect(errorCode(error)).not.toBe("UNAUTHORIZED");
      }
    }
  });

  it("denies every non-allowlisted procedure while impersonating", async () => {
    const rpc = client("admin", makeDeps());
    const unguarded: string[] = [];
    const deniedPaths: string[] = [];

    for (const path of contractProcedurePaths(appContract)) {
      const dotted = path.join(".");
      if (PUBLIC_PATHS.has(dotted)) continue;
      if (isImpersonationAllowedProcedure(path)) continue;

      try {
        await invokePath(rpc, path, {});
        unguarded.push(dotted);
      } catch (error) {
        if (
          errorCode(error) === "FORBIDDEN" &&
          errorMessage(error) === "Not allowed while impersonating"
        ) {
          deniedPaths.push(dotted);
          continue;
        }
        unguarded.push(`${dotted} (${errorCode(error) ?? "unknown"}: ${errorMessage(error) ?? String(error)})`);
      }
    }

    expect(deniedPaths).toEqual(
      expect.arrayContaining([
        "boards.rename",
        "tickets.create",
        "tickets.update",
        "tickets.move",
        "tickets.comment",
      ]),
    );
    expect(unguarded).toEqual([]);
  });
});
