import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  AssistantProfileRecord,
  AssistantSnapshot,
  AssistantTaskRunRecord,
  AssistantTurnRecord,
  ProjectRecord,
  UpsertAssistantProfileRequest,
} from "../shared/contracts";
import { MarkdownPreview } from "./MarkdownPreview";

export type AssistantSelection =
  | { mode: "profile"; id: string; editing?: boolean }
  | { mode: "new" };

interface AssistantPanelProps {
  assistant: AssistantSnapshot;
  projects: ProjectRecord[];
  selection: AssistantSelection;
  onSelectionChange(selection: AssistantSelection): void;
  embedded?: boolean;
}

interface ProfileDraft {
  name: string;
  enabled: boolean;
  projectPath: string;
  instructions: string;
  ownerWeComUserId: string;
  wecomBotEnabled: boolean;
  wecomBotId: string;
  wecomBotSecret: string;
  timeoutMinutes: number;
  maxTurns: number;
}

// Renderer and main-process code are upgraded together in a release, but a
// partially updated portable install can briefly deliver a snapshot from an
// older preload. Keep the configuration page usable while that snapshot is
// replaced instead of throwing while looking up a bound bot.
const EMPTY_ASSISTANT_BOTS: AssistantSnapshot["wecomBots"] = [];

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function isCutShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLocaleLowerCase("en-US") === "x"
  );
}

function profileDraft(
  profile: AssistantProfileRecord | undefined,
  projects: ProjectRecord[],
  bots: AssistantSnapshot["wecomBots"],
  fallbackBot?: { id: string; botId: string },
): ProfileDraft {
  const boundBot = profile?.wecomBotProfileId
    ? bots.find((bot) => bot.id === profile.wecomBotProfileId)
    : undefined;
  const boundBotId = profile?.wecomBotProfileId;
  const fallbackBoundBot =
    boundBotId && fallbackBot?.id === boundBotId ? fallbackBot : undefined;
  return {
    name: profile?.name ?? "",
    enabled: profile?.enabled ?? true,
    projectPath:
      profile?.projectPath?.trim() ||
      (profile?.projectId
        ? projects.find((project) => project.id === profile.projectId)?.rootPath ?? ""
        : ""),
    instructions: profile?.instructions ?? "",
    ownerWeComUserId: profile?.ownerWeComUserId ?? "",
    wecomBotEnabled: Boolean(profile?.wecomBotProfileId),
    // The profile save and the state event are separate IPC messages. During
    // that short window the bot list can still be one event behind; use the
    // submitted Bot ID as a display fallback until the authoritative snapshot
    // arrives.
    wecomBotId: boundBot?.botId ?? fallbackBoundBot?.botId ?? "",
    wecomBotSecret: "",
    timeoutMinutes: profile?.timeoutMinutes ?? 20,
    maxTurns: profile?.maxTurns ?? 20,
  };
}

function shortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function turnState(turn: AssistantTurnRecord): string {
  switch (turn.status) {
    case "queued":
      return "排队中";
    case "running":
      return "正在处理";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "timed-out":
      return "超时";
    case "cancelled":
      return "已取消";
  }
}

function taskRunState(run: AssistantTaskRunRecord | undefined): string {
  if (!run) {
    return "尚未运行";
  }
  switch (run.status) {
    case "queued":
      return "等待独立会话";
    case "running":
      return "独立会话执行中";
    case "succeeded":
      return "最近运行成功";
    case "failed":
      return "最近运行失败";
    case "timed-out":
      return "最近运行超时";
    case "cancelled":
      return "最近运行已取消";
    case "skipped":
      return "本次因重叠已跳过";
  }
}

function assistantOverviewLabel(assistant: AssistantSnapshot): string {
  if (!assistant.profiles.length) {
    return "尚未创建助理";
  }
  const enabledProfiles = assistant.profiles.filter((profile) => profile.enabled).length;
  const enabledTasks = assistant.tasks.filter((task) => task.enabled).length;
  const running = assistant.runningConversationIds.length;
  const scheduler = assistant.schedulerError ? " · 调度异常" : "";
  return `${enabledProfiles}/${assistant.profiles.length} 个可用 · ${enabledTasks} 个定时任务启用${running ? ` · ${running} 个正在处理` : ""}${scheduler}`;
}

function sameProfileDraft(left: ProfileDraft, right: ProfileDraft): boolean {
  return (
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.projectPath === right.projectPath &&
    left.instructions === right.instructions &&
    left.ownerWeComUserId === right.ownerWeComUserId &&
    left.wecomBotEnabled === right.wecomBotEnabled &&
    left.wecomBotId === right.wecomBotId &&
    left.wecomBotSecret === right.wecomBotSecret &&
    left.timeoutMinutes === right.timeoutMinutes &&
    left.maxTurns === right.maxTurns
  );
}

function matchesSavedProfile(
  candidate: AssistantProfileRecord | undefined,
  bots: AssistantSnapshot["wecomBots"],
  expected: AssistantProfileRecord,
): boolean {
  if (!candidate || candidate.id !== expected.id) {
    return false;
  }
  if (
    candidate.name !== expected.name ||
    candidate.enabled !== expected.enabled ||
    candidate.projectPath !== expected.projectPath ||
    candidate.instructions !== expected.instructions ||
    candidate.ownerWeComUserId !== expected.ownerWeComUserId ||
    candidate.wecomBotProfileId !== expected.wecomBotProfileId ||
    candidate.timeoutMinutes !== expected.timeoutMinutes ||
    candidate.maxTurns !== expected.maxTurns
  ) {
    return false;
  }
  return (
    !expected.wecomBotProfileId ||
    bots.some((bot) => bot.id === expected.wecomBotProfileId)
  );
}

export function AssistantPanel({
  assistant,
  projects,
  selection,
  onSelectionChange,
  embedded = false,
}: AssistantPanelProps) {
  const assistantBots = Array.isArray(assistant.wecomBots)
    ? assistant.wecomBots
    : EMPTY_ASSISTANT_BOTS;
  const selectedId = selection.mode === "profile" ? selection.id : null;
  const [editing, setEditing] = useState(
    selection.mode === "new" || Boolean(selection.editing),
  );
  const [draft, setDraft] = useState(() =>
    profileDraft(
      selection.mode === "profile"
        ? assistant.profiles.find((profile) => profile.id === selection.id)
        : undefined,
      projects,
      assistantBots,
    ),
  );
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const draftDirtyRef = useRef(false);
  const pendingSavedProfileRef = useRef<{
    profile: AssistantProfileRecord;
    draft: ProfileDraft;
  } | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const selectionKey =
    selection.mode === "new"
      ? "new"
      : `profile:${selection.id}:${selection.editing ? "edit" : "view"}`;
  const previousSelectionKeyRef = useRef(selectionKey);

  const replaceDraft = (next: ProfileDraft) => {
    draftDirtyRef.current = false;
    setDraft(next);
  };

  const updateDraft = (updates: Partial<ProfileDraft>) => {
    // A real edit supersedes any locally retained save result. This prevents a
    // delayed state event from replacing the user's new changes.
    pendingSavedProfileRef.current = null;
    draftDirtyRef.current = true;
    // Copy DOM values into a plain object in the event handler. React clears
    // SyntheticEvent.currentTarget after dispatch, so a functional state
    // updater must never read it later during rendering.
    setDraft((current) => ({ ...current, ...updates }));
  };

  const selected = assistant.profiles.find((profile) => profile.id === selectedId);
  const selectedBot = selected?.wecomBotProfileId
    ? assistantBots.find((bot) => bot.id === selected.wecomBotProfileId)
    : undefined;
  const turns = useMemo(
    () => assistant.turns.filter((turn) => turn.assistantId === selectedId),
    [assistant.turns, selectedId],
  );
  const visibleTurns = useMemo(
    () =>
      turns.filter(
        (turn) =>
          turn.status !== "queued" &&
          !(turn.status === "cancelled" && turn.startedAt === undefined),
      ),
    [turns],
  );
  const queuedTurns = useMemo(
    () => turns.filter((turn) => turn.status === "queued"),
    [turns],
  );
  const tasks = useMemo(
    () => assistant.tasks.filter((task) => task.assistantId === selectedId),
    [assistant.tasks, selectedId],
  );
  const taskRuns = useMemo(
    () => assistant.taskRuns.filter((run) => run.assistantId === selectedId),
    [assistant.taskRuns, selectedId],
  );
  const latestRunByTask = useMemo(() => {
    const latest = new Map<string, AssistantTaskRunRecord>();
    for (const run of taskRuns) latest.set(run.taskId, run);
    return latest;
  }, [taskRuns]);
  const running = turns.some((turn) => turn.status === "running");
  const hasActiveTurns = turns.some(
    (turn) => turn.status === "queued" || turn.status === "running",
  );
  const sessionOpen = selected ? assistant.openConversationIds.includes(selected.id) : false;
  const sessionResumable = selected
    ? (assistant.resumableConversationIds ?? []).includes(selected.id)
    : false;
  const assistantTitle = editing
    ? selected
      ? `配置 ${selected.name}`
      : "新建私人助理"
    : selected?.name ?? "私人助理";
  const wecomChannelLabel = selectedBot
    ? selectedBot.status === "connected"
      ? "企微在线"
      : selectedBot.status === "connecting"
        ? "企微连接中"
        : selectedBot.status === "error"
          ? "企微连接异常"
          : "企微已停用"
    : selected?.wecomBotProfileId
      ? "企微配置缺失"
      : "仅本地";
  const assistantHeaderMeta = [
    "PERSONAL AGENT",
    assistantOverviewLabel(assistant),
    !editing && selected
      ? `${sessionOpen ? "主人会话在线" : "主人会话已关闭"} · ${tasks.length} 个定时任务 · ${wecomChannelLabel}`
      : null,
  ].filter(Boolean).join(" · ");

  const focusComposerNow = () => {
    const input = messageInputRef.current;
    if (!input || input.disabled) {
      return false;
    }
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
    return true;
  };

  useEffect(() => {
    const next =
      selection.mode === "profile"
        ? assistant.profiles.find((profile) => profile.id === selection.id)
        : undefined;
    const selectionChanged = previousSelectionKeyRef.current !== selectionKey;
    const pendingSaved = pendingSavedProfileRef.current;
    if (
      pendingSaved &&
      (selection.mode !== "profile" || selection.id !== pendingSaved.profile.id)
    ) {
      pendingSavedProfileRef.current = null;
    }
    const activePendingSaved =
      pendingSaved &&
      selection.mode === "profile" &&
      selection.id === pendingSaved.profile.id
        ? pendingSaved
        : null;

    // A profile can be absent for one renderer event while the main process is
    // publishing the bot and profile updates. Keep the current view intact
    // until the profile appears instead of replacing it with a blank draft.
    if (selection.mode === "profile" && !next) {
      return;
    }

    if (selectionChanged) {
      previousSelectionKeyRef.current = selectionKey;
      setEditing(selection.mode === "new" || Boolean(selection.editing) || !next);
      if (
        activePendingSaved &&
        !matchesSavedProfile(
          next,
          assistantBots,
          activePendingSaved.profile,
        )
      ) {
        // The IPC response can arrive before the corresponding state event.
        // Keep the just-saved values visible instead of replacing them with
        // the previous snapshot while the main process publishes its update.
        replaceDraft(activePendingSaved.draft);
      } else {
        if (activePendingSaved) {
          pendingSavedProfileRef.current = null;
        }
        replaceDraft(profileDraft(next, projects, assistantBots));
      }
      setMessage("");
      setError(null);
      return;
    }

    // State events also carry the asynchronously-created bot record. Refresh
    // a clean form on the same selection so opening the configuration page
    // immediately after saving cannot show stale/empty Bot ID fields. A form
    // the user has edited remains untouched.
    if (!draftDirtyRef.current) {
      const nextDraft = profileDraft(next, projects, assistantBots);
      if (
        activePendingSaved &&
        !matchesSavedProfile(
          next,
          assistantBots,
          activePendingSaved.profile,
        )
      ) {
        setDraft((current) =>
          sameProfileDraft(current, activePendingSaved.draft)
            ? current
            : activePendingSaved.draft,
        );
      } else {
        if (activePendingSaved) {
          pendingSavedProfileRef.current = null;
        }
        setDraft((current) =>
          sameProfileDraft(current, nextDraft) ? current : nextDraft,
        );
      }
    }
  }, [
    assistant.profiles,
    assistantBots,
    projects,
    selectionKey,
    selection.mode,
    selectedId,
  ]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [visibleTurns.length, visibleTurns.at(-1)?.status]);

  // Session actions move focus to their button. Restore it to the chat
  // composer after the action (and its busy state) has settled so the next
  // message can be typed immediately, including after a closed/new session.
  useEffect(() => {
    if (editing || tab !== "chat" || !selected) {
      return;
    }
    let retryFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!focusComposerNow()) {
        retryFrame = window.requestAnimationFrame(focusComposerNow);
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (retryFrame !== undefined) {
        window.cancelAnimationFrame(retryFrame);
      }
    };
  }, [busy, composerFocusRequest, editing, selected?.enabled, selectedId, tab]);

  const requestComposerFocus = () => {
    // Focus synchronously while the click handler is still active. The
    // animation-frame retry below handles the subsequent React render, but
    // this immediate attempt lets users start typing during a slow close/new
    // conversation IPC operation.
    focusComposerNow();
    setComposerFocusRequest((current) => current + 1);
  };

  const choose = (profile: AssistantProfileRecord) => {
    pendingSavedProfileRef.current = null;
    onSelectionChange({ mode: "profile", id: profile.id });
    setEditing(false);
    replaceDraft(profileDraft(profile, projects, assistantBots));
    setMessage("");
    setError(null);
    requestComposerFocus();
  };

  const create = () => {
    pendingSavedProfileRef.current = null;
    onSelectionChange({ mode: "new" });
    setEditing(true);
    replaceDraft(profileDraft(undefined, projects, assistantBots));
    setMessage("");
    setError(null);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const inlineBot = draft.wecomBotEnabled
      ? {
          ...(selected?.wecomBotProfileId
            ? { id: selected.wecomBotProfileId }
            : {}),
          // The connection has no separate user-facing identity. Reuse the
          // assistant name so users never have to name the same assistant twice.
          name: draft.name.trim(),
          botId: draft.wecomBotId,
          secret: draft.wecomBotSecret,
          enabled: draft.enabled,
        }
      : null;
    const request: UpsertAssistantProfileRequest = {
      ...(selected ? { id: selected.id } : {}),
      name: draft.name,
      enabled: draft.enabled,
      projectPath: draft.projectPath,
      instructions: draft.instructions,
      ownerWeComUserId: draft.ownerWeComUserId,
      wecomBot: inlineBot,
      timeoutMinutes: draft.timeoutMinutes,
      maxTurns: draft.maxTurns,
    };
    try {
      const saved = await window.claudeWorkspace.upsertAssistantProfile(request);
      const savedDraft = profileDraft(
        saved,
        projects,
        assistantBots,
        inlineBot
          ? { id: saved.wecomBotProfileId ?? "", botId: inlineBot.botId }
          : undefined,
      );
      pendingSavedProfileRef.current = { profile: saved, draft: savedDraft };
      onSelectionChange({ mode: "profile", id: saved.id });
      replaceDraft(savedDraft);
      setEditing(false);
      requestComposerFocus();
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setBusy(false);
      requestComposerFocus();
    }
  };

  const send = async () => {
    if (!selected || !message.trim() || busy) return;
    const submittedMessage = message;
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.sendAssistantMessage({
        assistantId: selected.id,
        text: submittedMessage.trim(),
      });
      // Do not erase a new draft typed while the enqueue IPC call was in
      // flight. This is especially important now that session actions keep
      // the composer editable so closing/new sessions cannot strand input.
      setMessage((current) => (current === submittedMessage ? "" : current));
    } catch (sendError) {
      setError(readableError(sendError));
    } finally {
      setBusy(false);
      requestComposerFocus();
    }
  };

  const runSimpleAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(readableError(actionError));
    } finally {
      setBusy(false);
      requestComposerFocus();
    }
  };

  const chooseRuntimeDirectory = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selectedPath =
        await window.claudeWorkspace.selectAssistantProjectDirectory();
      if (selectedPath) {
        updateDraft({ projectPath: selectedPath });
      }
    } catch (selectionError) {
      setError(readableError(selectionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={embedded ? "assistant-page" : "assistant-backdrop"}
      role={embedded ? undefined : "presentation"}
    >
      <section
        className={embedded ? "assistant-dialog assistant-dialog--embedded" : "assistant-dialog"}
        role="dialog"
        aria-modal={embedded ? undefined : true}
        aria-labelledby="assistant-panel-title"
      >
        {!embedded ? (
          <aside className="assistant-list">
            <header><div className="assistant-brand-mark">影</div><div><strong>私人助理</strong><span>主人专属 Agent</span></div></header>
            <button type="button" className="assistant-new-button" onClick={create}>＋ 新建助理</button>
            <nav aria-label="私人助理列表">
              {assistant.profiles.map((profile) => {
                const thinking = assistant.runningConversationIds.includes(profile.id);
                const open = assistant.openConversationIds.includes(profile.id);
                return (
                  <button key={profile.id} type="button" className={selectedId === profile.id ? "assistant-list-row assistant-list-row--active" : "assistant-list-row"} onClick={() => choose(profile)}>
                    <span className="assistant-avatar">{profile.name.slice(0, 1)}</span>
                    <span><strong>{profile.name}</strong><small>{thinking ? "正在思考" : open ? "会话在线" : profile.enabled ? "等待主人" : "已停用"}</small></span>
                    <span className={`status-dot ${thinking ? "status-dot--pending" : open ? "status-dot--online" : "status-dot--offline"}`} />
                  </button>
                );
              })}
            </nav>
            <div className="assistant-list-note">本地与主人企微单聊共享一个会话；群内 @机器人发送 /chatid 可查看群 ID，其他群消息静默忽略。</div>
          </aside>
        ) : null}

        <main className="assistant-main">
          <header className="assistant-header assistant-header--compact">
            <div className="toolbar-title">
              <div className="toolbar-breadcrumb assistant-toolbar-breadcrumb">
                <span>私人助理</span>
                <span className="breadcrumb-divider">/</span>
                <h2 id="assistant-panel-title">{assistantTitle}</h2>
              </div>
              <p className="assistant-toolbar-meta" title={assistantHeaderMeta}>{assistantHeaderMeta}</p>
            </div>
          </header>

          {error ? <div className="assistant-inline-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
          {editing ? (
            <form className="assistant-config assistant-config-form assistant-config-form--profile" onSubmit={saveProfile}>
              <div className="assistant-config-intro"><strong>保持简单</strong><span>选择独立运行目录、写一句助理定位，就可以开始对话。定时任务以后直接在聊天里告诉它。</span></div>
              <div className="assistant-config-grid">
                <label>助理名称<input required maxLength={80} value={draft.name} onChange={(event) => updateDraft({ name: event.currentTarget.value })} /></label>
                <label className="assistant-runtime-field">运行目录
                  <div className="assistant-runtime-picker">
                    <input
                      required
                      readOnly
                      value={draft.projectPath}
                      placeholder="请选择助理独立运行目录"
                      title={draft.projectPath || "尚未选择运行目录"}
                    />
                    <button type="button" onClick={() => void chooseRuntimeDirectory()} disabled={busy}>选择目录</button>
                  </div>
                  <small>不会自动加入开发工作台；移除工作台工程也不会影响这里的助理。</small>
                </label>
              </div>
              <label>它是谁<textarea rows={4} maxLength={4_000} placeholder="例如：作为我的私人研究助理，先给结论，再补充关键依据。" value={draft.instructions} onChange={(event) => updateDraft({ instructions: event.currentTarget.value })} /></label>
              <section className="assistant-channel-card">
                <div>
                  <strong>企业微信智能机器人（可选入口）</strong>
                  <span>为这个助理绑定一个企业微信智能机器人；它接收主人单聊，群内 @机器人发送 /chatid 可查看群 ID，其他群消息不进入助理。</span>
                  <span>无需另起机器人名称，客户端始终使用上面的助理名称标识这条连接。</span>
                  <span>Bot ID 创建后不可修改；如需更换机器人，先取消绑定并保存，再重新配置。</span>
                </div>
                <label className="assistant-toggle">
                  <input
                    type="checkbox"
                    checked={draft.wecomBotEnabled}
                    onChange={(event) =>
                      updateDraft({
                        wecomBotEnabled: event.currentTarget.checked,
                      })
                    }
                  />
                  接入企业微信智能机器人
                </label>
                {draft.wecomBotEnabled ? (
                  <div className="assistant-config-grid assistant-wecom-inline-fields">
                    <label>
                      企业微信 Bot ID
                      <input
                        required
                        maxLength={200}
                        value={draft.wecomBotId}
                        readOnly={Boolean(selectedBot)}
                        title={selectedBot ? "已绑定机器人的 Bot ID 不可修改" : undefined}
                        placeholder="从企业微信管理后台复制"
                        onChange={(event) =>
                          updateDraft({
                            wecomBotId: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      {selectedBot?.hasSecret ? "Secret（留空保持不变）" : "Secret"}
                      <input
                        required={!selectedBot?.hasSecret}
                        maxLength={1_000}
                        type="password"
                        autoComplete="new-password"
                        value={draft.wecomBotSecret}
                        placeholder={selectedBot?.hasSecret ? "已安全保存；留空表示不修改" : "从企业微信管理后台复制"}
                        onChange={(event) =>
                          updateDraft({
                            wecomBotSecret: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      主人 userid
                      <input
                        required
                        maxLength={200}
                        placeholder="必须是企业微信回调 from.userid"
                        disabled={Boolean(selected?.ownerWeComUserId)}
                        value={draft.ownerWeComUserId}
                        onChange={(event) =>
                          updateDraft({
                            ownerWeComUserId: event.currentTarget.value,
                          })
                        }
                      />
                      <small>必须与企业微信回调的 from.userid 完全一致；非超级管理员创建的机器人可能返回加密 userid。</small>
                    </label>
                  </div>
                ) : (
                  <small>不接入企业微信时，助理仍可在本地完整使用。</small>
                )}
                {draft.wecomBotEnabled && selectedBot ? (
                  <small className={`assistant-wecom-inline-status assistant-wecom-inline-status--${selectedBot.status}`}>
                    当前状态：{selectedBot.status === "connected" ? "在线" : selectedBot.error ?? "未连接"}
                    {selectedBot.lastInboundAt
                      ? ` · 最近入站 ${shortTime(selectedBot.lastInboundAt)}：${selectedBot.lastInboundDetail ?? "已收到"}`
                      : " · 尚未收到入站消息"}
                  </small>
                ) : null}
              </section>
              <details className="assistant-advanced-settings">
                <summary>运行限制</summary>
                <div className="assistant-config-grid">
                  <label>单轮超时（分钟）<input type="number" min={1} max={120} value={draft.timeoutMinutes} onChange={(event) => updateDraft({ timeoutMinutes: Number(event.currentTarget.value) })} /></label>
                  <label>定时任务默认最大轮数<input type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => updateDraft({ maxTurns: Number(event.currentTarget.value) })} /></label>
                </div>
              </details>
              <label className="assistant-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })} />启用这个助理</label>
              <div className="assistant-permission-warning"><strong>主人拥有完整本机能力</strong><span>该助理可直接使用 Claude Code 的 Shell、文件、Chrome、Skills 和已配置 MCP。请保护系统登录与主人企业微信账号。</span></div>
              <div className="assistant-config-actions">
                {selected ? <button type="button" className="danger-button" disabled={busy} onClick={() => {
                  if (!window.confirm(`删除“${selected.name}”及客户端聊天、任务、运行记录和绑定的企业微信连接？Claude Code 自身历史不会删除。`)) return;
                  void runSimpleAction(async () => { await window.claudeWorkspace.deleteAssistantProfile(selected.id); });
                }}>删除助理</button> : null}
                <button type="button" disabled={busy} onClick={() => {
                  pendingSavedProfileRef.current = null;
                  const fallback = selected ?? assistant.profiles[0];
                  if (fallback) {
                    onSelectionChange({ mode: "profile", id: fallback.id });
                    setEditing(false);
                  } else {
                    onSelectionChange({ mode: "new" });
                    setEditing(true);
                  }
                  replaceDraft(profileDraft(fallback, projects, assistantBots));
                }}>取消</button>
                <button type="submit" className="primary-button" disabled={busy || !draft.projectPath.trim()}>{selected ? "保存" : "创建助理"}</button>
              </div>
            </form>
          ) : selected ? (
            <>
              <nav className="assistant-tabs" aria-label="助理内容"><button type="button" className={tab === "chat" ? "assistant-tab assistant-tab--active" : "assistant-tab"} onClick={() => { setTab("chat"); requestComposerFocus(); }}>主人聊天</button><button type="button" className={tab === "tasks" ? "assistant-tab assistant-tab--active" : "assistant-tab"} onClick={() => setTab("tasks")}>定时任务 <span>{tasks.length}</span></button></nav>
              {tab === "chat" ? (
                <>
                  <div className="assistant-session-actions">
                    <span>{sessionOpen ? "● Claude 会话常驻中" : sessionResumable ? "○ 会话已关闭，下条消息自动恢复" : "○ 尚未启动，下条消息创建会话"}</span>
                    <button type="button" disabled={busy || hasActiveTurns || !sessionOpen} onClick={() => { requestComposerFocus(); void runSimpleAction(() => window.claudeWorkspace.closeAssistantConversation(selected.id)); }}>关闭会话</button>
                    <button type="button" disabled={busy || hasActiveTurns} onClick={() => {
                      if (window.confirm("开始新对话会清除客户端展示记录和已保存的 Claude 会话关联；定时任务不受影响。继续吗？")) {
                        setMessage("");
                        requestComposerFocus();
                        void runSimpleAction(() => window.claudeWorkspace.resetAssistantConversation(selected.id));
                      }
                    }}>新对话</button>
                  </div>
                  <div className="assistant-messages">
                    {visibleTurns.length === 0 ? <div className="assistant-welcome"><span className="assistant-avatar assistant-avatar--large">{selected.name.slice(0, 1)}</span><h3>和 {selected.name} 开始对话</h3><p>你也可以直接说：“每个工作日 9 点帮我整理行业动态，有异常一定通知我。”</p></div> : visibleTurns.map((turn) => (
                      <div className="assistant-turn" key={turn.id}>
                        <article className="assistant-message assistant-message--user"><header><span>你</span><time>{shortTime(turn.createdAt)}</time></header><p>{turn.request}</p>{turn.source === "wecom" ? <small>来自企业微信</small> : null}</article>
                        <article className="assistant-message assistant-message--agent"><header><span>{selected.name}</span><small className={`assistant-turn-state assistant-turn-state--${turn.status}`}>{turnState(turn)}</small></header>{turn.response ? <MarkdownPreview content={turn.response} /> : turn.error ? <p className="assistant-message-error">{turn.error}</p> : <div className="assistant-thinking"><i /><i /><i /></div>}{turn.deliveryError ? <p className="assistant-delivery-error">{turn.deliveryError}</p> : null}</article>
                      </div>
                    ))}
                    <div ref={messageEndRef} />
                  </div>
                  {queuedTurns.length > 0 ? (
                    <section className="assistant-queued" aria-label="排队中的消息">
                      <header>
                        <strong>排队中的消息</strong>
                        <span>{queuedTurns.length} 条等待处理</span>
                      </header>
                      <ul>
                        {queuedTurns.map((turn) => (
                          <li key={turn.id}>
                            <p>{turn.request}</p>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void runSimpleAction(() =>
                                  window.claudeWorkspace.cancelAssistantTurn(
                                    selected.id,
                                    turn.id,
                                  ),
                                )
                              }
                            >
                              撤销
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  <footer className="assistant-composer-wrap"><div className="assistant-composer"><textarea ref={messageInputRef} aria-label="私人助理消息" title="可拖动右下角调整输入框高度" aria-keyshortcuts="Control+X Meta+X" value={message} rows={2} maxLength={4_000} placeholder={selected.enabled ? `给 ${selected.name} 发消息，或让它创建定时任务…` : "这个助理已停用"} disabled={!selected.enabled || (busy && running)} onChange={(event) => setMessage(event.currentTarget.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (isCutShortcut(event)) {
                      // Chromium/Electron normally performs the native cut. A
                      // direct command also covers hosts that intercept the
                      // shortcut before the textarea's default action.
                      if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
                        try {
                          if (document.execCommand("cut")) {
                            event.preventDefault();
                          }
                        } catch {
                          // Keep the browser's native cut fallback.
                        }
                      }
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }} />{running ? <button type="button" className="assistant-stop-button" disabled={busy} onClick={() => void runSimpleAction(() => window.claudeWorkspace.cancelAssistantTurn(selected.id))}>停止</button> : <button type="button" className="primary-button primary-button--compact" disabled={busy || !selected.enabled || !message.trim()} onClick={() => void send()}>发送</button>}</div><span>右下角可拖动调整高度 · Enter 发送 · Shift+Enter 换行 · Ctrl/Cmd+X 剪切 · 主聊天保持常驻；每次定时任务运行使用独立的一次性会话</span></footer>
                </>
              ) : (
                <div className="assistant-task-view">
                  {assistant.schedulerError ? <div className="assistant-task-alert" role="alert"><strong>调度器异常</strong><span>{assistant.schedulerError}</span><small>{assistant.schedulerErrorAt ? shortTime(assistant.schedulerErrorAt) : null}</small></div> : null}
                  <div className={assistant.schedulerActive ? "assistant-scheduler-health" : "assistant-scheduler-health assistant-scheduler-health--stopped"}>
                    <span className={`status-dot ${assistant.schedulerActive ? "status-dot--online" : "status-dot--offline"}`} />
                    <strong>{assistant.schedulerActive ? "调度器运行中" : "调度器已停止"}</strong>
                    <small>{assistant.lastSchedulerCheckAt ? `最近检查 ${shortTime(assistant.lastSchedulerCheckAt)}` : "尚未完成首次检查"}</small>
                  </div>
                  <header className="assistant-task-heading"><div><h3>独立执行的定时任务</h3><p>在主人聊天里创建和修改；每次运行不读取主聊天历史，也不复用上一次任务会话。</p></div><button type="button" className="primary-button" onClick={() => { setTab("chat"); setMessage("请帮我创建一个定时任务："); requestComposerFocus(); }}>在聊天里创建</button></header>
                  {tasks.length === 0 ? <div className="assistant-task-empty"><strong>还没有定时任务</strong><span>告诉助理什么时候做什么，它会确认并保存 Cron 计划。</span></div> : <div className="assistant-task-list">{tasks.map((task) => {
                    const latest = latestRunByTask.get(task.id);
                    const failed = latest && (latest.status === "failed" || latest.status === "timed-out" || latest.status === "cancelled" || latest.deliveryError);
                    return <article key={task.id} className={failed ? "assistant-task-card assistant-task-card--failed" : "assistant-task-card"}><header><div><span className={`status-dot ${task.enabled ? "status-dot--online" : "status-dot--offline"}`} /><strong>{task.name}</strong></div><code>{task.schedule}</code></header><p>{task.prompt}</p><footer><span className={`assistant-task-run-state assistant-task-run-state--${latest?.status ?? "idle"}`}>{taskRunState(latest)}</span>{latest ? <time>{shortTime(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)}</time> : null}</footer>{latest?.error ? <div className="assistant-task-run-error"><strong>执行异常</strong><span>{latest.error}</span></div> : null}{latest?.deliveryError ? <div className="assistant-task-run-error"><strong>通知主人失败</strong><span>{latest.deliveryError}</span></div> : null}{latest?.response ? <details><summary>查看最近结果</summary><MarkdownPreview content={latest.response} /></details> : null}</article>;
                  })}</div>}
                </div>
              )}
            </>
          ) : null}
        </main>
      </section>
    </div>
  );
}
