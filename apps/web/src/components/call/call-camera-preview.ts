/**
 * Local camera preview for the call strip user tile.
 * "When available" means permission is already granted — never prompt mid-call.
 * Never touches the call audio path.
 */
export async function cameraPreviewAlreadyGranted(
  permissions: Pick<Permissions, "query"> | undefined = navigator.permissions,
): Promise<boolean> {
  if (!permissions?.query) return false;
  try {
    const status = await permissions.query({ name: "camera" as PermissionName });
    return status.state === "granted";
  } catch {
    // Some browsers reject camera PermissionName; do not fall through to getUserMedia.
    return false;
  }
}
