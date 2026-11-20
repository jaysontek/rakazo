import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerStatus,
  Group,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import { ImpersonationReadOnlyNotice } from "../../components/ImpersonationReadOnlyNotice";
import { PagesList } from "../../components/pages/PagesList";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { computerPanelNeedsMaintenance } from "../../lib/thread-events";
import { CreateGroupForm, GroupSettings } from "../GroupPanel";
import { ResizableSidePanel } from "../ResizableSidePanel";
import { RoutineEditor } from "../RoutineEditor";
import type { SettingsSection } from "../shell-overlay";
import { AgentImportForm } from "./agent-import";
import type { BotPanelTab } from "./bot-panel";
import { BotSettings } from "./bot-panel";
import { firstThreadRoute } from "./use-shell-navigation";

/** The panel beside the chat: a bot's tabs, a routine, a group, or an import. */
export function ShellSidePanel({
  rpc,
  panel,
  setPanel,
  active,
  activeGroup,
  bots,
  groups,
  setBots,
  setGroups,
  navigate,
  refreshBots,
  refreshThread,
  refreshGroupThread,
  computer,
  computerOpen,
  booting,
  computerPanel,
  routinesPanel,
  routineEditorProps,
  openBot,
  openCreatedBot,
  modelFocusRequest,
  openSettings,
  memoryProviderConfigured,
  setAgentSkills,
  onClearBot,
  discardChatAttachments,
  readOnly = false,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  bots: Bot[];
  groups: Group[];
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  refreshThread: (botId: string) => Promise<ThreadSnapshot>;
  refreshGroupThread: (groupId: string) => Promise<ThreadSnapshot>;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  booting: boolean;
  computerPanel: ReactNode;
  routinesPanel: ReactNode;
  routineEditorProps: ComponentProps<typeof RoutineEditor> | null;
  openBot: (botId: string) => void;
  openCreatedBot: (bot: Bot) => void;
  modelFocusRequest: number;
  openSettings: (section: SettingsSection) => void;
  memoryProviderConfigured: boolean;
  setAgentSkills: (skills: AgentSkillCatalogEntry[]) => void;
  onClearBot: (bot: Bot) => void;
  /** Drops a deleted chat's pending attachments with their previews. */
  discardChatAttachments: (threadKey: string) => void;
  /** Disable bot/group/routine mutation controls while impersonating. */
  readOnly?: boolean;
}) {
  const { t } = useLingui();
  const open = Boolean(panel && (active || activeGroup || panel === "import-agent"));
  const botTab =
    panel === "computer" || panel === "routines" || panel === "pages" || panel === "settings"
      ? panel
      : null;

  async function createGroup(input: { name: string; botIds: string[] }) {
    if (readOnly) return;
    const group = await rpc.groups.create(input);
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  const mutationBody = (
    <>
      {panel === "create-group" ? (
        readOnly ? (
          <ImpersonationReadOnlyNotice />
        ) : (
          <CreateGroupForm
            bots={bots}
            onCancel={() => setPanel(null)}
            onCreate={(input) => createGroup(input)}
            onOpenBot={(botId) => {
              setPanel(null);
              openBot(botId);
            }}
          />
        )
      ) : null}
      {panel === "group-settings" && activeGroup ? (
        <fieldset disabled={readOnly} className="min-w-0 disabled:opacity-80">
          {readOnly ? (
            <>
              <legend className="sr-only">
                <Trans>Read-only</Trans>
              </legend>
              <ImpersonationReadOnlyNotice />
            </>
          ) : null}
          <GroupSettings
            key={activeGroup.id}
            group={activeGroup}
            bots={bots}
            pages={<PagesList groupId={activeGroup.id} />}
            onSave={async (input) => {
              if (readOnly) return;
              const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
              setGroups((current) =>
                current.map((group) => (group.id === updated.id ? updated : group)),
              );
              void Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                () => undefined,
              );
            }}
            onRemove={async () => {
              if (readOnly) return;
              await rpc.groups.remove({ groupId: activeGroup.id });
              discardChatAttachments(activeGroup.id);
              const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
              setGroups(remainingGroups);
              setPanel(null);
              navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
              await refreshBots().catch(() => undefined);
            }}
            onClose={() => setPanel(null)}
            onOpenBot={openBot}
            covered={computerOpen}
          />
        </fieldset>
      ) : null}
      {panel === "import-agent" ? (
        readOnly ? (
          <ImpersonationReadOnlyNotice />
        ) : (
          <AgentImportForm
            onClose={() => setPanel(null)}
            onCreated={(bot) => {
              openCreatedBot(bot);
              void refreshBots().catch(() => undefined);
            }}
          />
        )
      ) : null}
      {botTab && active ? (
        <fieldset disabled={readOnly} className="min-w-0 disabled:opacity-80">
          {readOnly ? (
            <>
              <legend className="sr-only">
                <Trans>Read-only</Trans>
              </legend>
              <ImpersonationReadOnlyNotice />
            </>
          ) : null}
          <BotSettings
            key={active.id}
            bot={active}
            tab={botTab}
            onTabChange={(tab: BotPanelTab) => {
              setPanel(tab);
              if (tab === "computer") void refreshThread(active.id).catch(() => undefined);
            }}
            computer={computerPanel}
            routines={routinesPanel}
            focusModel={modelFocusRequest}
            onOpenConnections={() => openSettings("models")}
            memoryProviderConfigured={memoryProviderConfigured}
            onSkillsChange={setAgentSkills}
            onSave={async ({ computerMode, ...patch }) => {
              if (readOnly) return;
              if (computerMode !== undefined && computerMode !== active.computerMode) {
                await rpc.bots.setComputer({
                  botId: active.id,
                  mode: computerMode,
                });
              }
              const updated = await rpc.bots.update({ botId: active.id, ...patch });
              setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)));
              // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
              await refreshBots().catch(() => undefined);
            }}
            onExport={async () => {
              if (readOnly) return;
              const manifest = await rpc.export.bot({ botId: active.id });
              const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            onClear={() => {
              if (!readOnly) onClearBot(active);
            }}
          />
        </fieldset>
      ) : null}
      {panel === "routine" && routineEditorProps ? (
        <fieldset disabled={readOnly} className="min-w-0 disabled:opacity-80">
          {readOnly ? (
            <>
              <legend className="sr-only">
                <Trans>Read-only</Trans>
              </legend>
              <ImpersonationReadOnlyNotice />
            </>
          ) : null}
          <RoutineEditor {...routineEditorProps} />
        </fieldset>
      ) : null}
    </>
  );

  return (
    <ResizableSidePanel open={open} panel={panel ?? "closed"}>
      {open ? (
        <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
          {panel !== "routine" &&
          panel !== "create-group" &&
          panel !== "group-settings" &&
          panel !== "import-agent" ? (
            <div className="mb-4 flex items-center justify-between">
              {!active && panel !== "settings" ? (
                <span className="text-[13.5px] text-muted-foreground">
                  <Trans>Group</Trans>
                </span>
              ) : null}
              <div className="ml-auto flex gap-1">
                {active &&
                panel === "computer" &&
                !computerOpen &&
                !readOnly &&
                computerPanelNeedsMaintenance(computer?.state, booting) ? (
                  <ComputerMaintenanceActions
                    botId={active.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshThread(active.id);
                    }}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Close panel`}
                  onClick={() => setPanel(null)}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
          ) : null}
          {mutationBody}
        </div>
      ) : null}
    </ResizableSidePanel>
  );
}
