import * as z from "zod";

/** Every security event the backend records. Alert queries match these strings. */
export const SECURITY_EVENT_TYPES = [
  "auth.sign_up",
  "auth.sign_up.failed",
  "auth.sign_in",
  "auth.sign_in.failed",
  "auth.sign_out",
  "auth.session.revoked",
  "auth.password.changed",
  "auth.passkey.added",
  "auth.passkey.changed",
  "auth.passkey.removed",
  "auth.account.deleted",
  "auth.account.deactivated",
  "auth.account.reactivated",
  "auth.account.soft_deleted",
  "auth.account.restored",
  "auth.account.restore.attempted",
  "auth.account.restore.failed",
  "auth.account.restore.otp_requested",
  "auth.account.purged",
  "auth.identity.confirmed",
  "credential.created",
  "credential.changed",
  "credential.deleted",
  "credential.revealed",
  "device.paired",
  "device.tied",
  "device.revoked",
  "deployment.settings.changed",
  "ops.admin_grant.added",
  "ops.admin_grant.removed",
  "ops.impersonation.started",
  "ops.impersonation.stopped",
  "ops.impersonation.expired",
  "ops.impersonation.switched",
  "ops.impersonation.denied",
  "ops.shared_key_allotment.transferred",
  "ops.shared_key_allotment.reversed",
  "ops.shared_key_spend.adjusted",
  "ops.shared_key_spend.set",
  "ops.shared_key_spend.reversed",
  "ops.shared_key_budget.settings.changed",
  "ops.shared_key_budget.member.removed",
  "ops.shared_key_budget.member.override",
  "ops.account.soft_deleted",
  "ops.account.restored",
  "ops.account.restore.attempted",
  "ops.account.restore.failed",
  "ops.account.budget_reenrolled",
  "ops.account.purged",
  "approval.decided",
  "approval.policy.changed",
  "egress.refused",
  "rate_limit.hit",
] as const;

export const SecurityEventTypeSchema = z.enum(SECURITY_EVENT_TYPES);
export type SecurityEventType = z.infer<typeof SecurityEventTypeSchema>;

/** Small, flat, and content-free: identifiers, kinds, and outcomes only. */
export const SecurityEventMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type SecurityEventMetadata = z.infer<typeof SecurityEventMetadataSchema>;

export const SecurityEventSchema = z.object({
  id: z.string(),
  type: SecurityEventTypeSchema,
  userId: z.string().nullable(),
  spaceId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: SecurityEventMetadataSchema,
  createdAt: z.string(),
});
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

export const SecurityEventListInputSchema = z.object({
  type: SecurityEventTypeSchema.optional(),
  ip: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  /** The id of the last event on the previous page; the next page starts just after it. */
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
