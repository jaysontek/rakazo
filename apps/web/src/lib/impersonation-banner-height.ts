/** CSS custom property published by ImpersonationBanner for fixed top overlays. */
export const IMPERSONATION_BANNER_HEIGHT_VAR = "--impersonation-banner-height";

/**
 * Publish the banner’s distance from the viewport top (getBoundingClientRect().bottom)
 * so fixed chrome clears both the banner and any #root safe-area inset above it.
 */
export function publishImpersonationBannerHeight(offsetPx: number): void {
  document.documentElement.style.setProperty(
    IMPERSONATION_BANNER_HEIGHT_VAR,
    `${Math.max(0, offsetPx)}px`,
  );
}

/** Reset the offset when the banner unmounts. */
export function clearImpersonationBannerHeight(): void {
  document.documentElement.style.setProperty(IMPERSONATION_BANNER_HEIGHT_VAR, "0px");
}
