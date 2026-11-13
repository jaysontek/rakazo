import {
  getAccountComputerSettings,
  getComputerProviderSettings,
  updateAccountComputerSettings,
  updateComputerProviderSettings,
} from "../computer-provider-config.js";
import { requireNotImpersonating } from "../impersonation.js";
import type { RouterContext } from "./context.js";

export function computerProviderRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    computerProvider: {
      get: authed.computerProvider.get.handler(async ({ context }) => {
        await requireNotImpersonating(deps, context.sessionId);
        return getComputerProviderSettings(deps, context.actor);
      }),
      update: authed.computerProvider.update.handler(async ({ context, input }) => {
        await requireNotImpersonating(deps, context.sessionId);
        return updateComputerProviderSettings(deps, context.actor, input);
      }),
      account: {
        get: authed.computerProvider.account.get.handler(({ context }) =>
          getAccountComputerSettings(deps, context.actor),
        ),
        update: authed.computerProvider.account.update.handler(({ context, input }) =>
          updateAccountComputerSettings(deps, context.actor, input),
        ),
      },
    },
  };
}
