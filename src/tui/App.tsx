import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { Orchestrator } from "../agent/orchestrator.js";
import type {
  ApprovalRequest,
  ChatMessage,
  ConnectionState,
  PlanStep,
  SessionInfo,
  ToolCallView,
  TurnPhase,
} from "../types.js";
import { firstLines } from "../utils/text.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { Header } from "./components/Header.js";
import { InputBar } from "./components/InputBar.js";
import { PlanPanel } from "./components/PlanPanel.js";
import { StatusBar } from "./components/StatusBar.js";
import { Transcript } from "./components/Transcript.js";
import { theme } from "./theme.js";
import { terminalText } from "./terminal-text.js";

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
};

export function App({ orchestrator }: { orchestrator: Orchestrator }) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [initialSession] = useState(() => orchestrator.currentSession);

  const [messages, setMessages] = useState<ChatMessage[]>(() => initialSession?.messages ?? []);
  const [tools, setTools] = useState<ToolCallView[]>(() => initialSession?.tools ?? []);
  const [notices, setNotices] = useState<Notice[]>(() => orchestrator.sessionStartupNotice ? [{ id: 0, level: "info", text: orchestrator.sessionStartupNotice }] : []);
  const [plan, setPlan] = useState<PlanStep[]>(() => initialSession?.plan ?? []);
  const [localSessionId, setLocalSessionId] = useState(() => initialSession?.id ?? "");
  const [phase, setPhase] = useState<TurnPhase>(() => orchestrator.currentPhase ?? "idle");
  const [status, setStatus] = useState<StatusMap>(() => ({
    ...emptyStatus,
    mcp: orchestrator.mcpUrl ? { state: "up", detail: orchestrator.mcpUrl } : emptyStatus.mcp!,
    ...orchestrator.serviceStatuses,
  }));
  const [session, setSession] = useState<SessionInfo | undefined>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approval = approvals[0];
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollLimit, setScrollLimit] = useState(0);
  const [now, setNow] = useState(Date.now());
  const noticeId = useRef(0);
  const activeTools = useRef(new Set<string>());
  const pendingApprovals = useRef(new Set<string>());
  const turnActive = useRef(false);
  const eventOrder = useRef(initialSession?.order ?? 0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubscribe = orchestrator.events.on((event) => {
      switch (event.type) {
        case "user-message":
        case "system-message":
          setScrollOffset(0);
          eventOrder.current += 1;
          {
          const order = eventOrder.current;
          setMessages((current) => [
            ...current,
            {
              id: event.id,
              role: event.type === "user-message" ? "user" : "system",
              text: event.text,
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

        case "status":
          setStatus((current) => ({
            ...current,
            [event.key]: { state: event.state, detail: event.detail },
          }));
          break;

        case "phase":
          setPhase((current) => current === "cancelling" && event.phase !== "idle" ? current : pendingApprovals.current.size ? "waiting-approval" : event.phase);
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
          setTools(event.session.tools);
          setPlan(event.session.plan);
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
          break;
        }

        case "turn-start":
          turnActive.current = true;
          setBusy(true);
          setNotices((current) => current.filter((notice) => notice.level !== "info"));
          break;

        case "turn-end":
          turnActive.current = false;
          setMessages((current) => current.map((message) =>
            message.streaming ? { ...message, streaming: false, interrupted: !event.ok } : message,
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
          setTools([]);
          setNotices([]);
          setPlan([]);
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

    if (key.pageUp) {
      setScrollOffset((current) => Math.min(scrollLimit, current + Math.max(1, Math.floor(rows / 2))));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((current) => Math.max(0, current - Math.max(1, Math.floor(rows / 2))));
      return;
    }

    if (key.ctrl && input === "d") {
      void orchestrator.showStatus();
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
    const text = value.trim();
    if (!text) return;
    setInputKey((current) => current + 1);
    void orchestrator.submit(text);
  };

  const timers = orchestrator.runtime?.timers?.list() ?? [];
  const processCount = (orchestrator.runtime?.exec?.list() ?? []).filter((job) => job.background && job.running).length;
  const taskCount = (orchestrator.runtime?.tasks?.list() ?? []).filter((task) => task.status === "running").length;
  const jobCount = processCount + taskCount;
  const showActivity = timers.length > 0 || jobCount > 0;
  const nextTimerSeconds = timers[0] ? Math.max(0, Math.ceil((timers[0].dueAt - now) / 1000)) : 0;
  const chrome =
    12 +
    (showActivity ? 1 : 0) +
    (approval ? 8 : 0) +
    (plan.length > 0 ? Math.min(plan.length + 3, 9) : 0) +
    Math.min(notices.length * 2, 6);
  const transcriptHeight = Math.max(6, rows - chrome);

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        localSessionId={localSessionId}
        model={session?.model ?? orchestrator.config.browser.modelLabel}
        session={session}
        approvalMode={orchestrator.config.approvalMode}
        contextUsage={orchestrator.contextUsage}
        status={status}
      />

      <Transcript
        messages={messages}
        tools={tools}
        height={transcriptHeight}
        scrollOffset={scrollOffset}
        onScrollLimit={setScrollLimit}
      />

      {showActivity ? (
        <Box paddingX={2} gap={2}>
          {timers.length ? <Text color={theme.accent}>◷ {timers.length} timer{timers.length === 1 ? "" : "s"} · next {nextTimerSeconds}s</Text> : null}
          {jobCount ? <Text color={theme.accentAlt}>◉ {jobCount} background job{jobCount === 1 ? "" : "s"}</Text> : null}
          <Text dimColor>/timers · /jobs</Text>
        </Box>
      ) : null}

      {notices.length > 0 ? (
        <Box flexDirection="column" paddingX={2} marginBottom={1}>
          {notices.slice(-3).map((notice) => (
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
              >
                {firstLines(terminalText(notice.text), 4, 220)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <PlanPanel steps={plan} />

      {approval ? <ApprovalPrompt request={approval} /> : null}

      <InputBar
        key={localSessionId}
        disabled={busy || Boolean(approval)}
        phase={phase}
        inputKey={inputKey}
        onSubmit={handleSubmit}
        initialHistory={messages.filter((message) => message.role === "user").map((message) => message.text)}
        placeholder={
          phase === "waiting-login"
            ? "Sign in to ChatGPT in the browser window…"
            : "Message…  /help commands · PgUp history"
        }
      />

      <StatusBar
        phase={phase}
        workspace={orchestrator.config.workspace}
        mcpUrl={orchestrator.mcpUrl}
        tunnelDetail={status.tunnel?.detail}
        approvalMode={orchestrator.config.approvalMode}
      />
    </Box>
  );
}
