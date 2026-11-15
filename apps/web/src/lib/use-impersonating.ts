import type { Me } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "./query";

/** Current impersonation payload from `rpc.me`, or null when viewing as yourself. */
export function useImpersonating(): Me["impersonating"] {
  const queries = useSpaceQueries();
  const me = useQuery(queries.me.queryOptions());
  return me.data?.impersonating ?? null;
}

/** True while an admin session is viewing another account read-only. */
export function useIsImpersonating(): boolean {
  return useImpersonating() != null;
}
