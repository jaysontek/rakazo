import { sharedKeyWeekStart } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

type TransferPrisma = Pick<
  PrismaClient,
  | "sharedKeyAllotmentTransfer"
  | "sharedKeyWeekAllotment"
  | "sharedKeyBudgetMember"
  | "usageRecord"
  | "$transaction"
  | "$queryRaw"
>;

type TransferTx = Pick<
  Prisma.TransactionClient,
  | "sharedKeyAllotmentTransfer"
  | "sharedKeyWeekAllotment"
  | "sharedKeyBudgetMember"
  | "usageRecord"
  | "$queryRaw"
>;

export type AllotmentTransferRow = {
  id: string;
  weekStart: string;
  fromUserId: string;
  toUserId: string;
  amountUsd: number;
  createdById: string;
  createdAt: string;
  reversedAt: string | null;
  reverseNote: string | null;
};

const MEMBERS_LOCK = "members";

async function lockSharedKeyBudget(tx: Pick<TransferTx, "$queryRaw">, key: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`shared-key-budget:${key}`}, 0))::text AS "lock"
  `);
}

function toRow(row: {
  id: string;
  weekStart: Date;
  fromUserId: string;
  toUserId: string;
  amountUsd: number;
  createdById: string;
  createdAt: Date;
  reversedAt: Date | null;
  reverseNote: string | null;
}): AllotmentTransferRow {
  return {
    id: row.id,
    weekStart: row.weekStart.toISOString(),
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    amountUsd: row.amountUsd,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reverseNote: row.reverseNote,
  };
}

async function spentSharedKeyUsd(
  prisma: Pick<TransferTx, "usageRecord">,
  userId: string,
  weekStart: Date,
  now: Date,
): Promise<number> {
  const { _sum } = await prisma.usageRecord.aggregate({
    _sum: { costUsd: true },
    where: {
      userId,
      sharedKey: true,
      createdAt: { gte: weekStart, lt: now },
    },
  });
  return _sum.costUsd ?? 0;
}

/**
 * Move the source's unused weekly remaining allotment onto the receiver.
 * Source then shows 100% used; receiver's allotment increases by that amount.
 */
export async function transferSharedKeyAllotment(
  prisma: TransferPrisma,
  input: { fromUserId: string; toUserId: string; createdById: string; now?: Date },
): Promise<AllotmentTransferRow> {
  if (input.fromUserId === input.toUserId) throw new Error("Cannot transfer to the same user");
  const now = input.now ?? new Date();
  const weekStart = sharedKeyWeekStart(now);
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const [fromMember, toMember] = await Promise.all([
      tx.sharedKeyBudgetMember.findUnique({ where: { userId: input.fromUserId } }),
      tx.sharedKeyBudgetMember.findUnique({ where: { userId: input.toUserId } }),
    ]);
    if (!fromMember || !toMember) throw new Error("Both users must be on the shared-key roster");
    const [fromRow, toRow] = await Promise.all([
      tx.sharedKeyWeekAllotment.findUnique({
        where: { weekStart_userId: { weekStart, userId: input.fromUserId } },
      }),
      tx.sharedKeyWeekAllotment.findUnique({
        where: { weekStart_userId: { weekStart, userId: input.toUserId } },
      }),
    ]);
    if (!fromRow || !toRow) throw new Error("Both users must have an allotment this week");
    const spent = await spentSharedKeyUsd(tx, input.fromUserId, weekStart, now);
    const remaining = Math.max(0, fromRow.allotmentUsd - spent - fromRow.reservedUsd);
    if (!(remaining > 0)) throw new Error("Source has no unused allotment to transfer");
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: input.fromUserId } },
      data: { allotmentUsd: spent + fromRow.reservedUsd },
    });
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: input.toUserId } },
      data: { allotmentUsd: toRow.allotmentUsd + remaining },
    });
    const created = await tx.sharedKeyAllotmentTransfer.create({
      data: {
        weekStart,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amountUsd: remaining,
        createdById: input.createdById,
      },
    });
    return toRowDto(created);
  });
}

function toRowDto(row: {
  id: string;
  weekStart: Date;
  fromUserId: string;
  toUserId: string;
  amountUsd: number;
  createdById: string;
  createdAt: Date;
  reversedAt: Date | null;
  reverseNote: string | null;
}): AllotmentTransferRow {
  return toRow(row);
}

export async function reverseSharedKeyAllotmentTransfer(
  prisma: TransferPrisma,
  input: { transferId: string; now?: Date },
): Promise<{ transfer: AllotmentTransferRow; clamped: boolean }> {
  const now = input.now ?? new Date();
  const weekStart = sharedKeyWeekStart(now);
  return prisma.$transaction(async (tx) => {
    await lockSharedKeyBudget(tx, MEMBERS_LOCK);
    const transfer = await tx.sharedKeyAllotmentTransfer.findUnique({
      where: { id: input.transferId },
    });
    if (!transfer) throw new Error("Transfer not found");
    if (transfer.reversedAt) throw new Error("Transfer already reversed");
    if (transfer.weekStart.getTime() !== weekStart.getTime()) {
      throw new Error("Cannot reverse a transfer from a prior week");
    }
    const [fromRow, toRow] = await Promise.all([
      tx.sharedKeyWeekAllotment.findUnique({
        where: { weekStart_userId: { weekStart, userId: transfer.fromUserId } },
      }),
      tx.sharedKeyWeekAllotment.findUnique({
        where: { weekStart_userId: { weekStart, userId: transfer.toUserId } },
      }),
    ]);
    if (!fromRow || !toRow) throw new Error("Allotment rows missing for reverse");
    const toSpent = await spentSharedKeyUsd(tx, transfer.toUserId, weekStart, now);
    const toFloor = toSpent + toRow.reservedUsd;
    const desiredTo = toRow.allotmentUsd - transfer.amountUsd;
    const clamped = desiredTo < toFloor;
    const nextTo = Math.max(toFloor, desiredTo);
    const restored = Math.max(0, toRow.allotmentUsd - nextTo);
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: transfer.toUserId } },
      data: { allotmentUsd: nextTo },
    });
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: transfer.fromUserId } },
      data: { allotmentUsd: fromRow.allotmentUsd + transfer.amountUsd },
    });
    const reverseNote = clamped
      ? `Receiver had already spent or reserved part of the transfer; restored $${restored.toFixed(2)} of $${transfer.amountUsd.toFixed(2)}.`
      : null;
    const updated = await tx.sharedKeyAllotmentTransfer.update({
      where: { id: transfer.id },
      data: { reversedAt: now, reverseNote },
    });
    return { transfer: toRowDto(updated), clamped };
  });
}

export async function listSharedKeyAllotmentTransfers(
  prisma: Pick<TransferPrisma, "sharedKeyAllotmentTransfer">,
  weekStart?: Date,
): Promise<AllotmentTransferRow[]> {
  const start = weekStart ?? sharedKeyWeekStart();
  const rows = await prisma.sharedKeyAllotmentTransfer.findMany({
    where: { weekStart: start },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRowDto);
}

/**
 * After allotments are rewritten (membership change or cap rebase), re-apply
 * active transfers for the week so moved credit stays with the receiver.
 */
export async function reapplyActiveTransfersTx(
  tx: TransferTx,
  weekStart: Date,
  spentByUser: ReadonlyMap<string, number>,
  reservedByUser: ReadonlyMap<string, number>,
): Promise<void> {
  const transfers = await tx.sharedKeyAllotmentTransfer.findMany({
    where: { weekStart, reversedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (transfers.length === 0) return;
  for (const transfer of transfers) {
    const fromRow = await tx.sharedKeyWeekAllotment.findUnique({
      where: { weekStart_userId: { weekStart, userId: transfer.fromUserId } },
    });
    const toRow = await tx.sharedKeyWeekAllotment.findUnique({
      where: { weekStart_userId: { weekStart, userId: transfer.toUserId } },
    });
    if (!fromRow || !toRow) continue;
    const spent = spentByUser.get(transfer.fromUserId) ?? 0;
    const reserved = reservedByUser.get(transfer.fromUserId) ?? fromRow.reservedUsd;
    const remaining = Math.max(0, fromRow.allotmentUsd - spent - reserved);
    const take = Math.min(transfer.amountUsd, remaining);
    if (!(take > 0)) continue;
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: transfer.fromUserId } },
      data: { allotmentUsd: fromRow.allotmentUsd - take },
    });
    await tx.sharedKeyWeekAllotment.update({
      where: { weekStart_userId: { weekStart, userId: transfer.toUserId } },
      data: { allotmentUsd: toRow.allotmentUsd + take },
    });
  }
}
