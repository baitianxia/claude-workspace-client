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
  AssistantTurnRecord,
  AutomationSnapshot,
  ProjectRecord,
  UpsertAssistantProfileRequest,
} from "../shared/contracts";
import { MarkdownPreview } from "./MarkdownPreview";
import { WeComBusinessBotDialog } from "./AutomationPanel";
import { projectDisplayName } from "./workspace-search";

interface AssistantPanelProps {
  assistant: AssistantSnapshot;
  automation: AutomationSnapshot;
  projects: ProjectRecord[];
  onClose(): void;
}

interface AssistantDraft {
  name: string;
  enabled: boolean;
  projectId: string;
  instructions: string;
  mcpConfigPath: string;
  allowedMcpServers: string;
  ownerWeComUserId: string;
  wecomBotProfileId: string;
  timeoutMinutes: string;
  maxTurns: string;
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function parseList(value: string): string[] {
  return value
    .split(/[,，;；\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function draftFor(
  profile: AssistantProfileRecord | undefined,
  projects: ProjectRecord[],
): AssistantDraft {
  return {
    name: profile?.name ?? "",
    enabled: profile?.enabled ?? true,
    projectId: profile?.projectId ?? projects[0]?.id ?? "",
    instructions: profile?.instructions ?? "",
    mcpConfigPath: profile?.mcpConfigPath ?? ".mcp.json",
    allowedMcpServers: profile?.allowedMcpServers.join("\n") ?? "",
    ownerWeComUserId: profile?.ownerWeComUserId ?? "",
    wecomBotProfileId: profile?.wecomBotProfileId ?? "",
    timeoutMinutes: String(profile?.timeoutMinutes ?? 20),
    maxTurns: String(profile?.maxTurns ?? 20),
  };
}

function turnState(turn: AssistantTurnRecord): string {
  switch (turn.status) {
    case "queued":
      return "等待中";
    case "running":
      return "正在思考";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "timed-out":
      return "已超时";
    case "cancelled":
      return "已停止";
  }
}

function shortTime(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function AssistantConfiguration({
  profile,
  assistant,
  automation,
  projects,
  draft,
  onDraft,
  onCancel,
  onSaved,
  onManageBots,
}: {
  profile?: AssistantProfileRecord;
  assistant: AssistantSnapshot;
  automation: AutomationSnapshot;
  projects: ProjectRecord[];
  draft: AssistantDraft;
  onDraft(draft: AssistantDraft): void;
  onCancel(): void;
  onSaved(profile: AssistantProfileRecord): void;
  onManageBots(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasHistory = Boolean(
    profile &&
      assistant.conversations.some(
        (conversation) =>
          conversation.assistantId === profile.id &&
          conversation.lastMessageAt !== undefined,
      ),
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const request: UpsertAssistantProfileRequest = {
        ...(profile ? { id: profile.id } : {}),
        name: draft.name,
        enabled: draft.enabled,
        projectId: draft.projectId,
        instructions: draft.instructions,
        mcpConfigPath: draft.mcpConfigPath,
        allowedMcpServers: parseList(draft.allowedMcpServers),
        ownerWeComUserId: draft.ownerWeComUserId,
        ...(draft.wecomBotProfileId
          ? { wecomBotProfileId: draft.wecomBotProfileId }
          : {}),
        timeoutMinutes: Number(draft.timeoutMinutes),
        maxTurns: Number(draft.maxTurns),
      };
      const saved = await window.claudeWorkspace.upsertAssistantProfile(request);
      onSaved(saved);
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !profile ||
      !window.confirm(
        `确认删除私人助理“${profile.name}”及客户端内的对话记录？Claude Code 自身保存的历史会话不会被删除。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.deleteAssistantProfile(profile.id);
      onCancel();
    } catch (deleteError) {
      setError(readableError(deleteError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="assistant-config" onSubmit={save}>
      <header className="assistant-config-header">
        <div>
          <span className="automation-eyebrow">ASSISTANT PROFILE</span>
          <h3>{profile ? `配置 ${profile.name}` : "创建私人助理"}</h3>
          <p>助理是主体；企业微信只是可选的远程入口。</p>
        </div>
        <label className="automation-inline-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              onDraft({ ...draft, enabled: event.currentTarget.checked })
            }
          />
          启用
        </label>
      </header>

      {error ? <div className="automation-error">{error}</div> : null}

      <div className="assistant-config-scroll">
        <div className="assistant-config-grid">
          <label>
            <span>助理名称</span>
            <input
              value={draft.name}
              maxLength={80}
              placeholder="例如：小岚"
              onChange={(event) =>
                onDraft({ ...draft, name: event.currentTarget.value })
              }
              required
            />
          </label>
          <label>
            <span>运行工程</span>
            <select
              value={draft.projectId}
              disabled={hasHistory}
              onChange={(event) =>
                onDraft({ ...draft, projectId: event.currentTarget.value })
              }
              required
            >
              <option value="">请选择工程</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {projectDisplayName(project)}
                </option>
              ))}
            </select>
            {hasHistory ? (
              <small>已有对话后固定运行工程，避免跨工程恢复私人上下文。</small>
            ) : null}
          </label>
        </div>

        <label className="assistant-config-field assistant-config-field--instructions">
          <span>助理指令</span>
          <textarea
            value={draft.instructions}
            maxLength={4_000}
            rows={5}
            placeholder="例如：你是我的私人研究助理，回答简洁，重要结论注明依据。"
            onChange={(event) =>
              onDraft({ ...draft, instructions: event.currentTarget.value })
            }
          />
          <small>只会进入主人会话，不会提供给其他企业微信用户或群聊。</small>
        </label>

        <section className="assistant-channel-card">
          <div>
            <strong>企业微信入口</strong>
            <span>可选。绑定后，主人单聊与本地聊天共享同一上下文。</span>
          </div>
          <div className="assistant-channel-controls">
            <select
              value={draft.wecomBotProfileId}
              onChange={(event) =>
                onDraft({
                  ...draft,
                  wecomBotProfileId: event.currentTarget.value,
                })
              }
            >
              <option value="">不绑定，仅客户端内使用</option>
              {automation.wecomBots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name} · {bot.status === "connected" ? "在线" : "未在线"}
                </option>
              ))}
            </select>
            <button type="button" onClick={onManageBots}>
              管理入口
            </button>
          </div>
          {draft.wecomBotProfileId ? (
            <label>
              <span>主人企业微信 userid</span>
              <input
                value={draft.ownerWeComUserId}
                maxLength={200}
                placeholder="例如：zhangsan"
                disabled={Boolean(profile?.ownerWeComUserId)}
                onChange={(event) =>
                  onDraft({
                    ...draft,
                    ownerWeComUserId: event.currentTarget.value,
                  })
                }
                required
              />
              <small>
                只接受这个身份的单聊。userid 保存后不可更换，填错时请新建助理。
              </small>
            </label>
          ) : null}
        </section>

        <details className="automation-advanced-settings">
          <summary>
            <span>
              <strong>个人能力与运行限制</strong>
              <small>MCP 工具只向主人会话开放</small>
            </span>
            <span>⌄</span>
          </summary>
          <div className="assistant-advanced-body">
            <label>
              <span>MCP 配置路径</span>
              <input
                value={draft.mcpConfigPath}
                maxLength={500}
                placeholder=".mcp.json"
                onChange={(event) =>
                  onDraft({ ...draft, mcpConfigPath: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>允许的 MCP 服务器</span>
              <textarea
                value={draft.allowedMcpServers}
                rows={3}
                placeholder="每行一个；留空表示纯对话"
                onChange={(event) =>
                  onDraft({
                    ...draft,
                    allowedMcpServers: event.currentTarget.value,
                  })
                }
              />
              <small>
                这是主人对个人数据能力的授权边界。不要加入未设防的高风险写操作服务。
              </small>
            </label>
            <div className="assistant-config-grid">
              <label>
                <span>单轮超时（分钟）</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={draft.timeoutMinutes}
                  onChange={(event) =>
                    onDraft({
                      ...draft,
                      timeoutMinutes: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                <span>最大 Agent 轮数</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.maxTurns}
                  onChange={(event) =>
                    onDraft({ ...draft, maxTurns: event.currentTarget.value })
                  }
                />
              </label>
            </div>
          </div>
        </details>

        <div className="assistant-security-note">
          <strong>默认不共享主人数据</strong>
          <span>
            非主人单聊和普通群聊会被静默忽略，不回复、不建会话，也不启动私人助理。只有本机客户端与上面指定的主人单聊能访问个人指令、历史、工程和 MCP 工具。
          </span>
        </div>
      </div>

      <footer className="assistant-config-actions">
        {profile ? (
          <button
            type="button"
            className="automation-danger-button"
            onClick={() => void remove()}
            disabled={busy}
          >
            删除助理
          </button>
        ) : (
          <span />
        )}
        <div>
          {profile ? (
            <button type="button" onClick={onCancel} disabled={busy}>
              取消
            </button>
          ) : null}
          <button
            type="submit"
            className="primary-button primary-button--compact"
            disabled={busy || projects.length === 0}
          >
            {busy ? "正在保存…" : profile ? "保存配置" : "创建并开始聊天"}
          </button>
        </div>
      </footer>
    </form>
  );
}

export function AssistantPanel({
  assistant,
  automation,
  projects,
  onClose,
}: AssistantPanelProps) {
  const initial = assistant.profiles[0];
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null);
  const [pendingProfile, setPendingProfile] =
    useState<AssistantProfileRecord | null>(null);
  const [editing, setEditing] = useState(!initial);
  const [draft, setDraft] = useState(() => draftFor(initial, projects));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const storedSelection = assistant.profiles.find(
    (profile) => profile.id === selectedId,
  );
  const selected =
    pendingProfile?.id === selectedId ? pendingProfile : storedSelection;
  const turns = useMemo(
    () =>
      assistant.turns
        .filter((turn) => turn.assistantId === selectedId)
        .sort((left, right) => left.createdAt - right.createdAt),
    [assistant.turns, selectedId],
  );
  const running = Boolean(
    selected && assistant.runningConversationIds.includes(selected.id),
  );

  useEffect(() => {
    if (
      pendingProfile &&
      assistant.profiles.some((profile) => profile.id === pendingProfile.id)
    ) {
      setPendingProfile(null);
      return;
    }
    if (
      selectedId &&
      pendingProfile?.id !== selectedId &&
      !assistant.profiles.some((profile) => profile.id === selectedId)
    ) {
      const next = assistant.profiles[0];
      setSelectedId(next?.id ?? null);
      setEditing(!next);
      setDraft(draftFor(next, projects));
    }
  }, [assistant.profiles, pendingProfile, projects, selectedId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, turns.at(-1)?.status]);

  const choose = (profile: AssistantProfileRecord) => {
    setPendingProfile(null);
    setSelectedId(profile.id);
    setEditing(false);
    setDraft(draftFor(profile, projects));
    setError(null);
  };

  const create = () => {
    setPendingProfile(null);
    setSelectedId(null);
    setEditing(true);
    setDraft(draftFor(undefined, projects));
    setError(null);
  };

  const send = async () => {
    const text = message.trim();
    if (!selected || !text || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.sendAssistantMessage({
        assistantId: selected.id,
        text,
      });
      setMessage("");
    } catch (sendError) {
      setError(readableError(sendError));
    } finally {
      setBusy(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const reset = async () => {
    if (
      !selected ||
      !window.confirm("开始新对话会清除客户端内当前助理的展示记录，并断开现有上下文。继续吗？")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.resetAssistantConversation(selected.id);
    } catch (resetError) {
      setError(readableError(resetError));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!selected) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.cancelAssistantTurn(selected.id);
    } catch (stopError) {
      setError(readableError(stopError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="assistant-backdrop" role="presentation">
      <section
        className="assistant-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assistant-panel-title"
      >
        <aside className="assistant-list">
          <header>
            <div className="assistant-brand-mark">影</div>
            <div>
              <strong>私人助理</strong>
              <span>本机 Agent</span>
            </div>
          </header>
          <button type="button" className="assistant-new-button" onClick={create}>
            ＋ 新建助理
          </button>
          <nav aria-label="私人助理列表">
            {assistant.profiles.map((profile) => {
              const profileRunning = assistant.runningConversationIds.includes(
                profile.id,
              );
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={
                    selectedId === profile.id
                      ? "assistant-list-row assistant-list-row--active"
                      : "assistant-list-row"
                  }
                  onClick={() => choose(profile)}
                >
                  <span className="assistant-avatar">{profile.name.slice(0, 1)}</span>
                  <span>
                    <strong>{profile.name}</strong>
                    <small>
                      {profileRunning
                        ? "正在思考"
                        : profile.enabled
                          ? "可以对话"
                          : "已停用"}
                    </small>
                  </span>
                  <span
                    className={`status-dot ${
                      profileRunning
                        ? "status-dot--pending"
                        : profile.enabled
                          ? "status-dot--online"
                          : "status-dot--offline"
                    }`}
                  />
                </button>
              );
            })}
          </nav>
          <div className="assistant-list-note">
            本地与主人企业微信单聊共享上下文；其他身份默认无权访问。
          </div>
        </aside>

        <main className="assistant-main">
          <header className="assistant-header">
            <div>
              <span className="automation-eyebrow">PERSONAL AGENT</span>
              <h2 id="assistant-panel-title">
                {editing ? (selected ? `配置 ${selected.name}` : "新建私人助理") : selected?.name ?? "私人助理 Agent"}
              </h2>
              {!editing && selected ? (
                <p>
                  {selected.wecomBotProfileId
                    ? `本地 + 主人企微单聊 · ${turns.length} 轮记录`
                    : `仅本地 · ${turns.length} 轮记录`}
                </p>
              ) : null}
            </div>
            <div className="assistant-header-actions">
              {!editing && selected ? (
                <>
                  <button type="button" onClick={() => void reset()} disabled={busy || running}>
                    新对话
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(draftFor(selected, projects));
                      setEditing(true);
                    }}
                    disabled={busy || running}
                  >
                    配置
                  </button>
                </>
              ) : null}
              <button type="button" aria-label="关闭私人助理" onClick={onClose}>
                ×
              </button>
            </div>
          </header>

          {editing ? (
            <AssistantConfiguration
              profile={selected}
              assistant={assistant}
              automation={automation}
              projects={projects}
              draft={draft}
              onDraft={setDraft}
              onCancel={() => {
                if (selected) {
                  setEditing(false);
                  setDraft(draftFor(selected, projects));
                } else {
                  const next = assistant.profiles[0];
                  setSelectedId(next?.id ?? null);
                  setEditing(!next);
                  setDraft(draftFor(next, projects));
                }
              }}
              onSaved={(saved) => {
                setPendingProfile(saved);
                setSelectedId(saved.id);
                setDraft(draftFor(saved, projects));
                setEditing(false);
              }}
              onManageBots={() => setBotDialogOpen(true)}
            />
          ) : selected ? (
            <>
              {error ? (
                <div className="assistant-inline-error" role="alert">
                  {error}
                  <button type="button" onClick={() => setError(null)}>×</button>
                </div>
              ) : null}
              <div className="assistant-messages">
                {turns.length === 0 ? (
                  <div className="assistant-welcome">
                    <span className="assistant-avatar assistant-avatar--large">
                      {selected.name.slice(0, 1)}
                    </span>
                    <h3>和 {selected.name} 开始对话</h3>
                    <p>
                      这里是主人会话。绑定企业微信后，你可以在手机单聊继续同一段上下文。
                    </p>
                  </div>
                ) : (
                  turns.map((turn) => (
                    <div className="assistant-turn" key={turn.id}>
                      <article className="assistant-message assistant-message--user">
                        <header><span>你</span><time>{shortTime(turn.createdAt)}</time></header>
                        <p>{turn.request}</p>
                        {turn.source === "wecom" ? <small>来自企业微信</small> : null}
                      </article>
                      <article className="assistant-message assistant-message--agent">
                        <header>
                          <span>{selected.name}</span>
                          <small className={`assistant-turn-state assistant-turn-state--${turn.status}`}>
                            {turnState(turn)}
                          </small>
                        </header>
                        {turn.response ? (
                          <MarkdownPreview content={turn.response} />
                        ) : turn.error ? (
                          <p className="assistant-message-error">{turn.error}</p>
                        ) : (
                          <div className="assistant-thinking"><i /><i /><i /></div>
                        )}
                        {turn.deliveryError ? (
                          <p className="assistant-delivery-error">{turn.deliveryError}</p>
                        ) : null}
                      </article>
                    </div>
                  ))
                )}
                <div ref={messageEndRef} />
              </div>
              <footer className="assistant-composer-wrap">
                <div className="assistant-composer">
                  <textarea
                    value={message}
                    rows={2}
                    maxLength={4_000}
                    placeholder={
                      selected.enabled
                        ? `给 ${selected.name} 发消息…`
                        : "这个助理已停用，请先在配置中启用"
                    }
                    disabled={!selected.enabled || busy}
                    onKeyDown={handleComposerKeyDown}
                    onChange={(event) => setMessage(event.currentTarget.value)}
                  />
                  {running ? (
                    <button type="button" className="assistant-stop-button" onClick={() => void stop()} disabled={busy}>
                      停止
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary-button primary-button--compact"
                      onClick={() => void send()}
                      disabled={busy || !selected.enabled || !message.trim()}
                    >
                      发送
                    </button>
                  )}
                </div>
                <span>Enter 发送 · Shift+Enter 换行 · 个人工具仅对主人会话开放</span>
              </footer>
            </>
          ) : null}
        </main>
      </section>

      {botDialogOpen ? (
        <WeComBusinessBotDialog
          bots={automation.wecomBots}
          onClose={() => setBotDialogOpen(false)}
          onSaved={(botProfileId) => {
            setDraft({ ...draft, wecomBotProfileId: botProfileId });
          }}
        />
      ) : null}
    </div>
  );
}
