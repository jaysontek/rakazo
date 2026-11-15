/** sessionStorage keys for the in-banner teammate switcher while impersonating. */

export const IMPERSONATION_ORG_ID_KEY = "rakazo:impersonation-org-id";
export const IMPERSONATION_TEAMMATES_KEY = "rakazo:impersonation-teammates";

export type ImpersonationTeammate = {
  userId: string;
  name: string;
  email: string;
};

export function storeImpersonationTeammates(
  organizationId: string,
  teammates: readonly ImpersonationTeammate[],
): void {
  try {
    sessionStorage.setItem(IMPERSONATION_ORG_ID_KEY, organizationId);
    sessionStorage.setItem(IMPERSONATION_TEAMMATES_KEY, JSON.stringify(teammates));
  } catch {
    // Private mode / quota: switcher stays hidden; stop still works.
  }
}

export function readImpersonationOrgId(): string | null {
  try {
    return sessionStorage.getItem(IMPERSONATION_ORG_ID_KEY);
  } catch {
    return null;
  }
}

export function readImpersonationTeammates(): ImpersonationTeammate[] {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_TEAMMATES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is ImpersonationTeammate =>
        Boolean(row) &&
        typeof row === "object" &&
        typeof (row as ImpersonationTeammate).userId === "string" &&
        typeof (row as ImpersonationTeammate).name === "string" &&
        typeof (row as ImpersonationTeammate).email === "string",
    );
  } catch {
    return [];
  }
}

export function clearImpersonationTeammates(): void {
  try {
    sessionStorage.removeItem(IMPERSONATION_ORG_ID_KEY);
    sessionStorage.removeItem(IMPERSONATION_TEAMMATES_KEY);
  } catch {
    // Ignore storage failures on stop.
  }
}

/** Drop cached teammates when me/bootstrap reports the server is not impersonating. */
export function syncImpersonationTeammatesFromServer(impersonating: unknown): void {
  if (!impersonating) clearImpersonationTeammates();
}
