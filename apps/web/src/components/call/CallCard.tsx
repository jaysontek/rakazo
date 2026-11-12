import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { endCall, useCallSession } from "../../lib/call-session";
import { CallStrip } from "./CallStrip";

const EDITABLE = /^(?:input|textarea|select)$/i;

/**
 * Call chrome when the active thread's composer is not showing it — for example on
 * Artifacts or another bot. Never covers the app; the thread stays usable.
 */
export function CallCard({ onSettings }: { onSettings: () => void }) {
  const call = useCallSession();
  const { botId } = useParams();
  const onCall = Boolean(call);
  useEffect(() => {
    if (!onCall) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || EDITABLE.test(target?.tagName ?? "")) return;
      endCall();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCall]);
  // The matching bot's composer hosts the strip; elsewhere keep a compact dock.
  // Escape still hangs up above even when this dock is hidden.
  if (!call || botId === call.botId) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3 pb-[max(env(safe-area-inset-bottom),12px)] md:inset-x-auto md:end-4 md:bottom-4 md:justify-end md:p-0">
      <CallStrip
        onSettings={onSettings}
        className="pointer-events-auto w-full max-w-md shadow-lg md:w-[360px]"
      />
    </div>
  );
}

/** Kept for CallLayout imports; the strip stays in reach without a minimize bar. */
export function CallReturnBar() {
  return null;
}
