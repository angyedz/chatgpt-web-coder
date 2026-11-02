import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import wrapAnsi from "wrap-ansi";
import type { Orchestrator } from "../agent/orchestrator.js";
import type {
  ApprovalRequest,
  ChatMessage,
  ConnectionState,
  PlanStep,
  SessionInfo,
  SubagentSnapshot,
  ToolCallView,
  TelegramSetupState,
  TurnPhase,
} from "../types.js";
import { oneLine } from "../utils/text.js";
import { ApprovalPrompt, approvalHeight } from "./components/ApprovalPrompt.js";
import { ActivityBar } from "./components/ActivityBar.js";
import { Header } from "./components/Header.js";
import { InputBar } from "./components/InputBar.js";
import { PlanPanel } from "./components/PlanPanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { Transcript } from "./components/Transcript.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { SubagentStrip } from "./components/SubagentStrip.js";
import { theme } from "./theme.js";
import { terminalText } from "./terminal-text.js";
import { useMouseWheel } from "./useMouseWheel.js";
import type { ScreenSelection } from "./screen-selection.js";

interface Notice {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

type StatusMap = Record<
  string,
  { state: ConnectionState; detail?: string }
>;

const emptyStatus: StatusMap = {
  browser: { state: "off" },
  mcp: { state: "off" },
  tunnel: { state: "off" },
  searxng: { state: "off" },
  telegram: { state: "off" },
};
const noTools: ToolCallView[] = [];

export function App({ orchestrator, selection }: { orchestrator: Orchestrator; selection?: ScreenSelection }) {
  const { exit } = useApp();
  const { rows = 24, columns = 100 } = useWindowSize();
  const [initialSession] = useState(() => orchestrator.currentSession);

  const [messages, setMessages] = useState<ChatMessage[]>(() => initialSession?.messages ?? []);
  const [showSystemLog, setShowSystemLog] = useState(false);
  const [tools, setTools] = useState<ToolCallView[]>(() => initialSession?.tools ?? []);
  const [notices, setNotices] = useState<Notice[]>(() => orchestrator.sessionStartupNotice ? [{ id: 0, level: "info", text: orchestrator.sessionStartupNotice }] : []);
  const [plan, setPlan] = useState<PlanStep[]>(() => initialSession?.plan ?? []);
  const [agents, setAgents] = useState<SubagentSnapshot[]>(() => orchestrator.subagents.snapshots);
  const [goal, setGoal] = useState(() => initialSession?.goal);
  const [attachments, setAttachments] = useState(() => initialSession?.attachments ?? []);
  const [localSessionId, setLocalSessionId] = useState(() => initialSession?.id ?? "");
  const [phase, setPhase] = useState<TurnPhase>(() => orchestrator.currentPhase ?? "idle");
  const [status, setStatus] = useState<StatusMap>(() => ({
    ...emptyStatus,
    mcp: orchestrator.mcpUrl ? { state: "up", detail: orchestrator.mcpUrl } : emptyStatus.mcp!,
    ...orchestrator.serviceStatuses,
  }));
  const [session, setSession] = useState<SessionInfo | undefined>();
  const [pendingUpdate, setPendingUpdate] = useState<{ kind: "download" | "local" | "rollback"; version: string } | undefined>();
  const [connectorRefresh, setConnectorRefresh] = useState(() => orchestrator.connectorRefresh);
  const [telegramSetup, setTelegramSetup] = useState<TelegramSetupState>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approval = approvals[0];
  const [busy, setBusy] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | undefined>();
  const [inputKey, setInputKey] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollLimit, setScrollLimit] = useState(0);
  const [now, setNow] = useState(Date.now());
  const noticeId = useRef(0);
  const visibleMessages = useMemo(() => messages.filter((message) => showSystemLog ? message.role === "system" : message.role !== "system"), [messages, showSystemLog]);
  const activeTools = useRef(new Set<string>());
  const pendingApprovals = useRef(new Set<string>());
  const turnActive = useRef(false);
  const eventOrder = useRef(initialSession?.order ?? 0);
  const timers = orchestrator.runtime?.timers?.list() ?? [];
  const processCount = (orchestrator.runtime?.exec?.list() ?? []).filter((job) => job.background && job.running).length;
  const taskCount = (orchestrator.runtime?.tasks?.list() ?? []).filter((task) => task.status === "running").length;
  const jobCount = processCount + taskCount;
  const showActivity = timers.length > 0 || jobCount > 0;

  useEffect(() => {
    if (!showActivity) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [showActivity]);

  useEffect(() => {
    const unsubscribe = orchestrator.events.on((event) => {
      switch (event.type) {
        case "subagents":
          setAgents(event.agents);
          break;

        case "user-message":
        case "system-message":
          setScrollOffset(0);
          setShowSystemLog(event.type === "system-message");
          eventOrder.current += 1;
          {
          const order = eventOrder.current;
          setMessages((current) => [
            ...current,
            {
              id: event.id,
              role: event.type === "user-message" ? "user" : "system",
              text: event.text,
              ...(event.type === "user-message" && event.channel ? { channel: event.channel } : {}),
              createdAt: Date.now(),
              order,
            },
          ]);
          }
          break;

        case "assistant-start":
          eventOrder.current += 1;
          {
          const order = eventOrder.current;
          setMessages((current) => [
            ...current,
            {
              id: event.id,
              role: "assistant",
              ...(event.channel ? { channel: event.channel } : {}),
              text: "",
              createdAt: Date.now(),
              order,
              streaming: true,
            },
          ]);
          }
          break;

        case "assistant-delta":
          {
          const order = ++eventOrder.current;
          setMessages((current) => {
            const existing = current.find((message) => message.id === event.id);
            if (!existing) {
              return [
                ...current,
                {
                  id: event.id,
                  role: "assistant",
                  ...(event.channel ? { channel: event.channel } : {}),
                  text: event.text,
                  createdAt: Date.now(),
                  order,
                  streaming: true,
                },
              ];
            }
            return current.map((message) =>
              message.id === event.id
                ? { ...message, text: event.text, streaming: true }
                : message,
            );
          });
          }
          break;

        case "assistant-done":
          {
          const order = ++eventOrder.current;
          setMessages((current) => {
            const existing = current.find((message) => message.id === event.id);
            if (!existing) {
              return [
                ...current,
                {
                  id: event.id,
                  role: "assistant",
                  ...(event.channel ? { channel: event.channel } : {}),
                  text: event.text,
                  createdAt: Date.now(),
                  order,
                  streaming: false,
                  interrupted: Boolean(event.error),
                },
              ];
            }
            return current.map((message) =>
              message.id === event.id
                ? { ...message, text: event.text, streaming: false, interrupted: Boolean(event.error) }
                : message,
            );
          });
          }
          break;

        case "tool-start":
          activeTools.current.add(event.call.id);
          {
          const order = ++eventOrder.current;
          setTools((current) => [...current, { ...event.call, order }]);
          }
          break;

        case "tool-end":
          activeTools.current.delete(event.call.id);
          if (activeTools.current.size === 0) {
            setPhase((current) => current === "tool" ? "thinking" : current);
          }
          setTools((current) =>
            current.map((call) => (call.id === event.call.id ? { ...event.call, order: call.order } : call)),
          );
          break;

        case "plan":
          setPlan(event.steps);
          break;

        case "goal":
          setGoal(event.goal);
          break;

        case "attachments":
          setAttachments(event.attachments);
          break;

        case "status":
          setStatus((current) => ({
            ...current,
            [event.key]: { state: event.state, detail: event.detail },
          }));
          break;

        case "phase":
          setPhase((current) => current === "cancelling" && event.phase !== "idle" ? current : pendingApprovals.current.size ? "waiting-approval" : event.phase);
          break;

        case "update-selection":
          setPendingUpdate(event.pending);
          break;

        case "mcp-refresh":
          setConnectorRefresh(event.reminder);
          break;

        case "telegram-setup":
          setTelegramSetup(event.state);
          break;

        case "session":
          setSession(event.session);
          break;

        case "session-view":
          setScrollOffset(0);
          activeTools.current.clear();
          pendingApprovals.current.clear();
          eventOrder.current = event.session.order;
          setMessages(event.session.messages);
          setShowSystemLog(false);
          setTools(event.session.tools);
          setPlan(event.session.plan);
          setGoal(event.session.goal);
          setAttachments(event.session.attachments ?? []);
          setNotices([]);
          setApprovals([]);
          setLocalSessionId(event.session.id);
          break;

        case "approval":
          pendingApprovals.current.add(event.request.id);
          setApprovals((current) => [...current, event.request]);
          setPhase("waiting-approval");
          break;

        case "approval-resolved":
          pendingApprovals.current.delete(event.id);
          setApprovals((current) => current.filter((request) => request.id !== event.id));
          if (pendingApprovals.current.size === 0) setPhase((current) => current === "waiting-approval" ? activeTools.current.size ? "tool" : turnActive.current ? "thinking" : "idle" : current);
          break;

        case "notice": {
          noticeId.current += 1;
          const notice: Notice = {
            id: noticeId.current,
            level: event.level,
            text: event.text,
          };
          setNotices((current) => [...current.slice(-7), notice]);
          if (event.level === "error") {
            const order = ++eventOrder.current;
            setScrollOffset(0);
            setMessages((current) => [...current, { id: `notice-error-${notice.id}`, role: "system", text: event.text, createdAt: Date.now(), order }]);
          }
          break;
        }

        case "turn-start":
          turnActive.current = true;
          setTurnStartedAt(Date.now());
          setBusy(true);
          setNotices((current) => current.filter((notice) => notice.level !== "info"));
          break;

        case "turn-end":
          turnActive.current = false;
          setTurnStartedAt(undefined);
          setMessages((current) => current.map((message) =>
            message.streaming && message.channel !== "btw" ? { ...message, streaming: false, interrupted: !event.ok } : message,
          ));
          setBusy(false);
          setPhase(pendingApprovals.current.size ? "waiting-approval" : "idle");
          break;

        case "clear":
          setScrollOffset(0);
          activeTools.current.clear();
          pendingApprovals.current.clear();
          eventOrder.current = 0;
          setMessages([]);
          setShowSystemLog(false);
          setTools([]);
          setNotices([]);
          setPlan([]);
          setGoal(undefined);
          setAttachments([]);
          setApprovals([]);
          break;

        case "quit":
          exit();
          break;

        default:
          break;
      }
    });
    setStatus((current) => ({ ...current, ...orchestrator.serviceStatuses }));
    setPhase((current) => orchestrator.currentPhase ?? current);
    setConnectorRefresh(orchestrator.connectorRefresh);
    return unsubscribe;
  }, [orchestrator, exit]);

  useInput((input, key) => {
    if (approval) {
      if (input.toLowerCase() === "y") {
        orchestrator.approve(approval.id, true);
        setApprovals((current) => current.filter((request) => request.id !== approval.id));
      } else if (input.toLowerCase() === "n" || key.escape) {
        orchestrator.approve(approval.id, false);
        setApprovals((current) => current.filter((request) => request.id !== approval.id));
      }
      return;
    }

    if (key.escape && telegramSetup) {
      orchestrator.cancelTelegramSetup();
      return;
    }

    if (key.pageUp) {
      setScrollOffset((current) => Math.min(scrollLimit, current + Math.max(1, Math.floor(rows / 2))));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((current) => Math.max(0, current - Math.max(1, Math.floor(rows / 2))));
      return;
    }

    if (key.ctrl && input === "o") {
      setShowSystemLog((current) => !current);
      setScrollOffset(0);
      return;
    }

    if (key.ctrl && input === "d") {
      void orchestrator.showStatus();
      return;
    }

    if (key.ctrl && input === "r" && connectorRefresh) {
      void orchestrator.dismissConnectorRefresh();
      return;
    }

    if (key.ctrl && input === "c") {
      if (busy) {
        if (phase !== "cancelling") orchestrator.cancel();
      } else {
        exit();
      }
      return;
    }

    if (key.escape && busy && phase !== "cancelling") {
      orchestrator.cancel();
    }
  });

  const handleSubmit = (value: string) => {
    if (telegramSetup?.stage === "token") {
      const token = value.trim();
      if (!token) return false;
      void orchestrator.submitTelegramToken(token);
      return true;
    }
    if (telegramSetup?.stage === "pairing") {
      if (/^\s*\/telegram\s+cancel\s*$/i.test(value)) {
        void orchestrator.submit("/telegram cancel");
        return true;
      }
      noticeId.current += 1;
      setNotices((current) => [...current.slice(-7), { id: noticeId.current, level: "info", text: "Pair the bot from its private Telegram chat, or press Esc to cancel." }]);
      return false;
    }
    if (!value.trim() && !attachments.some((item) => item.pending)) return false;
    if (busy && !/^\s*\/(?:btw|swarm)(?:\s|$)/i.test(value)) {
      void orchestrator.submit(value);
      return false;
    }
    if (/^\s*\/btw(?:\s|$)/i.test(value) && (!value.replace(/^\s*\/btw\s*/i, "").trim() || value.replace(/^\s*\/btw\s*/i, "").trim().length > 12_000 || (orchestrator.btwActive && value.replace(/^\s*\/btw\s*/i, "").trim().toLowerCase() !== "cancel"))) {
      void orchestrator.submit(value);
      return false;
    }
    setInputKey((current) => current + 1);
    void orchestrator.submit(value);
    return true;
  };

  const displayedPlan = plan;
  const displayedGoal = goal;
  const displayedAttachments = attachments;
  const displayedNotices = notices;
  const displayedUpdate = pendingUpdate;
  const timerCount = timers.length;
  const displayedJobCount = jobCount;
  const nextTimerSeconds = timers[0] ? Math.max(0, Math.ceil((timers[0].dueAt - now) / 1000)) : 0;
  const showHeader = rows >= 12;
  const showStatus = rows >= 10;
  const showInput = !approval || rows >= 12;
  const showJobs = Boolean((timerCount || displayedJobCount) && rows >= 20 && !approval);
  const showAgentStrip = agents.length > 0 && rows >= 16 && !approval;
  const showLive = busy && !approval && rows >= 14;
  const showUpdate = Boolean(displayedUpdate && !busy && !approval && rows >= 8);
  const showGoal = Boolean(displayedGoal && rows >= 16 && !approval);
  const pendingAttachments = displayedAttachments.filter((item) => item.pending);
  const showAttachments = pendingAttachments.length > 0 && rows >= 12 && !approval;
  const maxPlanSteps = displayedPlan.length && !approval && rows >= 17 ? (rows < 24 ? 1 : 3) : 0;
  const shownNotices = rows >= 20 && !approval ? displayedNotices.slice(-2) : [];
  const refreshLines = connectorRefresh && rows >= 12 && !approval ? [
    connectorRefresh.result === "changed" ? "MCP tools changed · refresh the ChatGPT connector" : "Could not compare MCP tools · check the ChatGPT connector",
    "ChatGPT account settings → Plugins → ⚙ (gear)",
    `Select ${terminalText(connectorRefresh.name)} → scroll down → Refresh tools`,
    "Ctrl+R to dismiss",
  ].flatMap((line) => wrapAnsi(line, Math.max(1, columns - 4), { hard: true }).split("\n")) : [];
  const baseChrome = (showHeader ? 3 : 0) + (showStatus ? 1 : 0) + (showInput ? 3 : 0)
    + (showLive ? 1 : 0) + (showAgentStrip ? 1 : 0) + (showUpdate ? 1 : 0) + (showAttachments ? 1 : 0)
    + (approval ? approvalHeight(approval, columns, rows) : 0) + refreshLines.length
    + (telegramSetup ? telegramSetup.stage === "token" ? 4 + (telegramSetup.error ? 1 : 0) : 7 : 0);
  const showSidebar = columns >= 130 && rows >= 22 && !approval && rows - baseChrome >= 10
    && Boolean(displayedGoal || displayedPlan.length || agents.length || showJobs || shownNotices.some((notice) => notice.level !== "info"));
  const sidebarWidth = showSidebar ? Math.min(56, Math.max(36, Math.floor(columns / 3))) : 0;
  const chatWidth = columns - sidebarWidth;
  const chrome = baseChrome + (showSidebar ? 0 : (showJobs ? 1 : 0) + (showGoal ? 1 : 0) + shownNotices.length
    + (maxPlanSteps ? 2 + Math.min(displayedPlan.length, maxPlanSteps) : 0));
  const transcriptHeight = Math.max(0, rows - chrome);
  useMouseWheel({ top: showHeader ? 3 : 0, height: transcriptHeight, width: chatWidth }, (direction) => {
    setScrollOffset((current) => Math.max(0, Math.min(scrollLimit, current + direction * 3)));
  }, selection, (text) => {
    noticeId.current += 1;
    setNotices((current) => [...current.slice(-7), { id: noticeId.current, level: "error", text }]);
  });

  return (
    <Box flexDirection="column" height={rows}>
      {showHeader ? <Header
        localSessionId={localSessionId}
        model={session?.model ?? orchestrator.config.browser.modelLabel}
        session={session}
        approvalMode={orchestrator.config.approvalMode}
        contextUsage={orchestrator.contextUsage}
        status={status}
      /> : null}

      {transcriptHeight > 0 ? <Box width={columns} height={transcriptHeight} flexShrink={0}>
        <Box width={chatWidth} height={transcriptHeight} flexShrink={0}>
          <Transcript
            messages={visibleMessages}
            tools={showSystemLog ? noTools : tools}
            systemView={showSystemLog}
            width={chatWidth}
            height={transcriptHeight}
            scrollOffset={scrollOffset}
            onScrollLimit={setScrollLimit}
            selection={selection}
            screenTop={showHeader ? 3 : 0}
          />
        </Box>
        {showSidebar ? <TaskSidebar
          width={sidebarWidth}
          height={transcriptHeight}
          goal={displayedGoal}
          steps={displayedPlan}
          notices={shownNotices}
          jobs={displayedJobCount}
          timers={timerCount}
          nextTimerSeconds={nextTimerSeconds}
          agents={agents}
        /> : null}
      </Box> : null}

      {showJobs && !showSidebar ? (
        <Box paddingX={2} gap={2} flexShrink={0}>
          {timerCount ? <Text color={theme.accent} wrap="truncate-end">◷ {timerCount} timer{timerCount === 1 ? "" : "s"} · {nextTimerSeconds}s</Text> : null}
          {displayedJobCount ? <Text color={theme.accentAlt} wrap="truncate-end">◉ {displayedJobCount} background job{displayedJobCount === 1 ? "" : "s"}</Text> : null}
          {columns >= 70 ? <Text color={theme.dim}>/timers · /jobs</Text> : null}
        </Box>
      ) : null}

      {shownNotices.length > 0 && !showSidebar ? (
        <Box flexDirection="column" paddingX={2} flexShrink={0}>
          {shownNotices.map((notice) => (
            <Box key={notice.id} gap={1}>
              <Text
                color={
                  notice.level === "error"
                    ? theme.error
                    : notice.level === "warn"
                      ? theme.warn
                      : theme.dim
                }
              >
                {notice.level === "error" ? "✗" : notice.level === "warn" ? "!" : "·"}
              </Text>
              <Text
                color={
                  notice.level === "error"
                    ? theme.error
                    : notice.level === "warn"
                      ? theme.warn
                      : undefined
                }
                dimColor={notice.level === "info"}
                wrap="truncate-end"
              >
                {oneLine(terminalText(notice.text), Math.max(20, columns - 7))}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {showAttachments ? <Box paddingX={2} flexShrink={0}><Text color={theme.accentAlt} wrap="truncate-end">◇ {pendingAttachments.length} attached · {oneLine(terminalText(pendingAttachments.map((item) => item.name).join(" · ")), Math.max(8, columns - 35))} <Text color={theme.dim}>/attachments</Text></Text></Box> : null}

      {showGoal && displayedGoal && !showSidebar ? <Box paddingX={2} flexShrink={0}><Text color={displayedGoal.status === "active" ? theme.accent : displayedGoal.status === "complete" ? theme.ok : theme.warn} wrap="truncate-end">◇ GOAL · {displayedGoal.status} · {oneLine(terminalText(displayedGoal.objective), Math.max(10, columns - 30))}</Text></Box> : null}

      {!showSidebar ? <PlanPanel steps={displayedPlan} maxVisible={maxPlanSteps} /> : null}

      {approval ? <ApprovalPrompt request={approval} /> : null}

      {showAgentStrip && !showSidebar ? <SubagentStrip agents={agents} columns={columns} /> : null}

      {showLive ? <ActivityBar phase={phase} startedAt={turnStartedAt} /> : null}

      {showUpdate && displayedUpdate ? (
        <Box paddingX={2} flexShrink={0}>
          <Text color={theme.dim} wrap="truncate-end"><Text bold color={theme.warn}>◇ Approval required: /update apply</Text>{`  ·  ${displayedUpdate.kind === "download" ? "Downloaded" : displayedUpdate.kind === "rollback" ? "Rollback" : "Selected"} ${terminalText(displayedUpdate.version)}  ·  /update cancel`}</Text>
        </Box>
      ) : null}

      {refreshLines.length ? <Box flexDirection="column" paddingX={2} flexShrink={0}>
        {refreshLines.map((line, index) => <Text key={index} color={index === 0 ? theme.warn : theme.dim} wrap="truncate-end">{line}</Text>)}
      </Box> : null}

      {telegramSetup ? <Box flexDirection="column" marginX={2} flexShrink={0} borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>TELEGRAM · SECURE SETUP</Text>
        {telegramSetup.stage === "token" ? <>
          <Text color={theme.dim}>Paste the BotFather token into the masked field below. It will not appear in chat history.</Text>
          {telegramSetup.error ? <Text color={theme.error} wrap="truncate-end">{terminalText(telegramSetup.error)}</Text> : null}
        </> : <>
          <Text>Open <Text color={theme.accent}>@{terminalText(telegramSetup.botUsername)}</Text> in Telegram and press Start.</Text>
          <Text>Send these three words in that private chat to link its Telegram account:</Text>
          <Text bold color={theme.warn}>{telegramSetup.words.join(" ")}</Text>
          <Text color={theme.dim}>This one-time phrase expires in 10 minutes and allows at most 5 tries per account / 20 total. Only the first account paired by phrase can control the harness. Press Esc to cancel.</Text>
        </>}
      </Box> : null}

      {showInput ? <InputBar
        key={localSessionId}
        disabled={(busy && !orchestrator.canSendBtw) || Boolean(approval)}
        phase={phase}
        inputKey={inputKey}
        onSubmit={handleSubmit}
        onPasteImage={(value) => orchestrator.attachPastedImage(value)}
        onPasteClipboardImage={() => orchestrator.attachPastedClipboardImage()}
        onPasteError={(text) => {
          noticeId.current += 1;
          setNotices((current) => [...current.slice(-7), { id: noticeId.current, level: "error", text: `Paste: ${text}` }]);
        }}
        hasAttachments={pendingAttachments.length > 0}
        secure={telegramSetup?.stage === "token"}
        initialHistory={messages.filter((message) => message.role === "user" && message.channel !== "telegram").map((message) => message.text)}
        placeholder={
          telegramSetup?.stage === "token"
            ? "Bot token · hidden · Enter to verify · Esc to cancel"
            : telegramSetup?.stage === "pairing"
              ? "Waiting for private-chat pairing · Esc to cancel"
            : busy
            ? "Working…  /btw <message>  ·  /swarm status  ·  Esc to stop"
            : phase === "waiting-login"
            ? "Sign in to ChatGPT in the browser window…"
            : "Message or /command…  ·  /attach"
        }
      /> : null}

      {showStatus ? <StatusBar
        phase={phase}
        workspace={orchestrator.config.workspace}
        mcpUrl={orchestrator.mcpUrl}
        tunnelDetail={status.tunnel?.detail}
        approvalMode={orchestrator.config.approvalMode}
        showPhase={!showLive}
      /> : null}
    </Box>
  );
}
