import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type PointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { labelOf, type PetSession, phaseLabel } from "./agents";
import { Notification } from "./Notification";
import { PetLauncher } from "./PetLauncher";
import { ProjectDots } from "./ProjectDots";
import { indicatorLabel, projectIndicators } from "./projectIndicators";
import { usePetBubble } from "./usePetBubble";
import { usePetDismiss } from "./usePetDismiss";
import { usePetNotice } from "./usePetNotice";
import { usePetReminder } from "./usePetReminder";
import { usePetSessions } from "./usePetSessions";
import { usePetVisibility } from "./window";

const ignorePause = () => {};

export function PetApp() {
  const { visible, epoch } = usePetVisibility();
  const scope = useMemo(() => ({ visible, epoch }), [visible, epoch]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const roster = usePetSessions(visible, epoch);
  const agents = useMemo(
    () =>
      (roster.ready ? roster.sessions : []).filter(
        (session) => session.agent && session.runId !== null,
      ),
    [roster.ready, roster.sessions],
  );
  const notice = usePetNotice(
    visible,
    epoch,
    roster.notices,
    agents,
    roster.contextPending,
  );
  const reminder = usePetReminder(visible);
  const [error, setError] = useState<{
    scope: typeof scope;
    text: string;
  } | null>(null);
  const actionError = error?.scope === scope ? error.text : null;
  const bubble = usePetBubble(
    visible,
    epoch,
    !!actionError || !!reminder.shown || !!notice.session,
  );
  const dragGate = useRef(false);
  const revealGate = useRef(false);
  const menuGate = useRef(false);
  const closeGate = useRef(false);
  const [revealing, setRevealing] = useState(false);
  const projects = projectIndicators(agents, new Set(roster.unread));
  const phase = projects.some((project) => project.status === "attention")
    ? "attention"
    : agents.some((session) => session.phase === "working")
      ? "working"
      : "idle";
  const dismiss = () => {
    setError(null);
    notice.dismissAll();
    void reminder.dismiss();
  };
  const checkFocus = usePetDismiss(
    visible,
    epoch,
    bubble.notification,
    () => menuGate.current || dragGate.current,
    dismiss,
  );
  const fail = (text: string) => {
    if (latestScope.current === scope) setError({ scope, text });
  };
  const reveal = async (session: PetSession | null = null) => {
    if (!visible || latestScope.current !== scope || revealGate.current) return;
    revealGate.current = true;
    setRevealing(true);
    try {
      await invoke("pet_reveal", {
        leafId: session?.leafId ?? null,
        ptyId: session?.ptyId ?? null,
        runId: session?.runId ?? null,
      });
      if (latestScope.current !== scope) return;
      setError(null);
      notice.dismissAll();
      roster.refresh();
    } catch {
      fail(
        session
          ? "无法打开对应对话，会话可能已结束，请刷新后重试。"
          : "无法打开主窗口，请重试。",
      );
    } finally {
      revealGate.current = false;
      setRevealing(false);
    }
  };
  const activate = () => {
    if (actionError) setError(null);
    else if (reminder.shown) void reminder.dismiss();
    else void reveal(notice.session);
  };
  const startDrag = useCallback(
    async (event: PointerEvent<HTMLButtonElement>) => {
      if ((event.buttons & 1) === 0 || !event.isPrimary || dragGate.current)
        return;
      event.preventDefault();
      event.stopPropagation();
      dragGate.current = true;
      try {
        await getCurrentWindow().startDragging();
      } catch {
        if (latestScope.current === scope)
          setError({ scope, text: "拖动失败，请重试。" });
      } finally {
        dragGate.current = false;
        bubble.reposition();
        void checkFocus();
      }
    },
    [scope, bubble.reposition, checkFocus],
  );
  const contextMenu = async (projectsOnly = false) => {
    if (menuGate.current || !visible) return;
    menuGate.current = true;
    let menu: Menu | undefined;
    const menuLabel = (session: PetSession) =>
      labelOf(session)
        .replace(/[\t\r\n]/g, " ")
        .replace(/&/g, "&&");
    try {
      menu = await Menu.new({
        items: projectsOnly
          ? projects.map((project, index) => ({
              id: `awei-work:pet:status:${index}`,
              text: `${menuLabel(project.session)} · ${indicatorLabel(project)}`,
              checked: project.session.active,
              enabled: !revealing && !roster.error && !roster.contextPending,
              action: () => void reveal(project.session),
            }))
          : [
              {
                id: "awei-work:pet:terminal",
                text: "打开终端",
                action: () => void reveal(),
              },
              {
                id: "awei-work:pet:projects",
                text: "打开对话",
                enabled:
                  agents.length > 0 &&
                  !revealing &&
                  !roster.error &&
                  !roster.contextPending,
                items: agents.map((session, index) => ({
                  id: `awei-work:pet:project:${index}`,
                  text:
                    menuLabel(session) +
                    " · " +
                    (session.awaitingChoice
                      ? "等待选择"
                      : session.phase === "working" ||
                          session.phase === "attention"
                        ? phaseLabel(session.phase)
                        : session.agent),
                  checked: session.active,
                  action: () => void reveal(session),
                })),
              },
              { item: "Separator" },
              {
                id: "awei-work:pet:hide",
                text: "隐藏宠物",
                action: () => {
                  if (closeGate.current) return;
                  closeGate.current = true;
                  void invoke("close_pet_window")
                    .catch(() => fail("隐藏失败，请重试。"))
                    .finally(() => {
                      closeGate.current = false;
                    });
                },
              },
            ],
      });
      if (latestScope.current === scope) setError(null);
      await menu.popup();
    } catch {
      fail("无法打开菜单，请重试。");
    } finally {
      try {
        await menu?.close();
      } catch {}
      menuGate.current = false;
      void checkFocus();
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: This group contains window actions and notices, not form fields.
    <div
      className="pet-window"
      role="group"
      aria-label="桌面宠物"
      data-below={bubble.styles.below}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.repeat && bubble.notification) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void contextMenu();
      }}
    >
      {bubble.notification && actionError ? (
        <Notification
          style={bubble.styles.notice}
          sentence={actionError}
          pending={false}
          onOpen={() => setError(null)}
          onDismiss={() => setError(null)}
          onPause={ignorePause}
        />
      ) : bubble.notification && reminder.shown ? (
        <Notification
          style={bubble.styles.notice}
          sentence={reminder.shown.text}
          reminder
          pending={reminder.pending}
          onOpen={() => void reminder.dismiss()}
          onDismiss={() => void reminder.dismiss()}
          onPause={reminder.setPaused}
        />
      ) : bubble.notification && notice.session ? (
        <Notification
          style={bubble.styles.notice}
          sentence={notice.sentence}
          pending={revealing}
          onOpen={() => void reveal(notice.session)}
          onDismiss={notice.dismiss}
          onPause={notice.setPaused}
        />
      ) : null}
      <div
        className="pet-companion"
        data-phase={phase}
        style={bubble.styles.icon}
      >
        <PetLauncher
          phase={phase}
          pending={revealing}
          label={
            actionError || reminder.shown
              ? "关闭提醒"
              : notice.session
                ? "打开对应对话"
                : "打开主窗口"
          }
          onActivate={activate}
          onDrag={(event) => void startDrag(event)}
        />
        <ProjectDots
          projects={projects}
          pending={revealing || roster.contextPending}
          stale={!!roster.error}
          onSelect={(session) => void reveal(session)}
          onMore={() => void contextMenu(true)}
        />
      </div>
    </div>
  );
}
