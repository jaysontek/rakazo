import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import { canMarkMessageUnread } from "@rakazo/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { Copy, MessageSquareDot, MoreHorizontal, Reply, Smile } from "lucide-react";
import { useState } from "react";
import { MessageHoverMetadata } from "../../components/MessageHoverMetadata";
import { copyableMessageText } from "../../lib/message-text";

export function MessageHoverActions({
  message,
  side,
  onReply,
  onMarkUnread,
  markedUnread = false,
  onReact,
  readOnly = false,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnread?: boolean;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  /** Keep copy; hide reply/react/unread while impersonating. */
  readOnly?: boolean;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const iconButtonClass =
    "grid h-11 w-11 place-items-center text-muted-foreground transition-colors hover:text-foreground [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen} side={side}>
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        {!readOnly && canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger aria-label={t`React`} className={iconButtonClass}>
              <Smile size={15} strokeWidth={1.7} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        {readOnly ? null : (
          <button
            type="button"
            aria-label={t`Reply`}
            onClick={() => onReply(message)}
            className={iconButtonClass}
          >
            <Reply size={15} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger aria-label={t`More`} className={iconButtonClass}>
            <MoreHorizontal size={15} strokeWidth={1.7} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={side === "end" ? "start" : "end"} className="w-auto">
            {readOnly ? null : (
              <DropdownMenuItem
                onClick={() => {
                  setMoreOpen(false);
                  onReply(message);
                }}
              >
                <Reply size={14} strokeWidth={1.7} aria-hidden="true" />
                <Trans>Reply</Trans>
              </DropdownMenuItem>
            )}
            {!readOnly && canMarkMessageUnread(message) && !markedUnread ? (
              <DropdownMenuItem
                onClick={() => {
                  setMoreOpen(false);
                  onMarkUnread(message);
                }}
              >
                <MessageSquareDot size={14} strokeWidth={1.7} aria-hidden="true" />
                <Trans>Mark as unread</Trans>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={copyMessage}>
              <Copy size={14} strokeWidth={1.7} aria-hidden="true" />
              <Trans>Copy</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </MessageHoverMetadata>
  );
}
