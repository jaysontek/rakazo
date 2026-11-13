/**
 * Accounts on builddrive.net (and any subdomain) are hidden from the LAN ops
 * dashboard: lists, pickers, and usage tables. Match is case-insensitive.
 */
export function isHiddenOpsEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return domain === "builddrive.net" || domain.endsWith(".builddrive.net");
}
