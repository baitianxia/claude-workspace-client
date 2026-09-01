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
  AssistantWeComBotProfile,
  ProjectRecord,
  UpsertAssistantProfileRequest,
} from "../shared/contracts";
import { MarkdownPreview } from "./MarkdownPreview";

interface AssistantPanelProps {
  assistant: AssistantSnapshot;
  projects: ProjectRecord[];
  onClose(): void;
}

interface ProfileDraft {
  name: string;
  enabled: boolean;
  projectId: string;
  instructions: string;
  ownerWeComUserId: string;
  wecomBotProfileId: string;
  timeoutMinutes: number;
  maxTurns: number;
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function profileDraft(
  profile: AssistantProfileRecord | undefined,
  projects: ProjectRecord[],
): ProfileDraft {
  return {
    name: profile?.name ?? "",
    enabled: profile?.enabled ?? true,
    projectId: profile?.projectId ?? projects[0]?.id ?? "",
    instructions: profile?.instructions ?? "",
    ownerWeComUserId: profile?.ownerWeComUserId ?? "",
    wecomBotProfileId: profile?.wecomBotProfileId ?? "",
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

function WeComEntryDialog({
  bots,
  onClose,
  onSaved,
}: {
  bots: AssistantWeComBotProfile[];
  onClose(): void;
  onSaved(botProfileId: string): void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (bot?: AssistantWeComBotProfile) => {
    setEditingId(bot?.id ?? null);
    setName(bot?.name ?? "");
    setBotId(bot?.botId ?? "");
    setSecret("");
    setEnabled(bot?.enabled ?? true);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await window.claudeWorkspace.upsertAssistantWeComBot({
        ...(editingId ? { id: editingId } : {}),
        name,
        botId,
        secret,
        enabled,
      });
      onSaved(saved.id);
      edit();
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="automation-backdrop" role="presentation">
      <section className="assistant-entry-dialog" role="dialog" aria-modal="true">
        <header className="assistant-header">
          <div>
            <span className="automation-eyebrow">REMOTE ENTRY</span>
            <h2>企业微信助理入口</h2>
            <p>只负责主人单聊入口；不能与 Claude Code 管理机器人共用 Bot ID。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {error ? <div className="assistant-inline-error" role="alert">{error}</div> : null}
        <div className="assistant-entry-layout">
          <div className="assistant-entry-list">
            {bots.length ? bots.map((bot) => (
              <button key={bot.id} type="button" onClick={() => edit(bot)}>
                <span className={`status-dot status-dot--${bot.status === "connected" ? "online" : bot.status === "connecting" ? "pending" : "offline"}`} />
                <span><strong>{bot.name}</strong><small>{bot.status === "connected" ? "在线" : bot.error ?? "未连接"}</small></span>
              </button>
            )) : <p className="assistant-empty-copy">尚未配置助理入口。</p>}
            <button type="button" className="assistant-new-button" onClick={() => edit()}>＋ 新建入口</button>
          </div>
          <form className="assistant-config-form" onSubmit={save}>
            <label>入口名称<input value={name} maxLength={80} required onChange={(event) => setName(event.currentTarget.value)} /></label>
            <label>企业微信 Bot ID<input value={botId} maxLength={200} required disabled={Boolean(editingId)} onChange={(event) => setBotId(event.currentTarget.value)} /></label>
            <label>{editingId ? "Secret（留空保持不变）" : "Secret"}<input value={secret} maxLength={1_000} type="password" required={!editingId} onChange={(event) => setSecret(event.currentTarget.value)} /></label>
            <label className="assistant-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />启用并保持在线</label>
            <div className="assistant-config-actions">
              {editingId ? (
                <button type="button" className="danger-button" disabled={busy} onClick={() => {
                  if (!window.confirm("删除这个助理入口？已绑定助理时会被阻止。")) return;
                  setBusy(true);
                  void window.claudeWorkspace.deleteAssistantWeComBot(editingId).then(() => edit()).catch((deleteError: unknown) => setError(readableError(deleteError))).finally(() => setBusy(false));
                }}>删除</button>
              ) : null}
              <button type="submit" className="primary-button" disabled={busy}>{editingId ? "保存入口" : "创建入口"}</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

export function AssistantPanel({ assistant, projects, onClose }: AssistantPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    assistant.profiles[0]?.id ?? null,
  );
  const [editing, setEditing] = useState(assistant.profiles.length === 0);
  const [draft, setDraft] = useState(() =>
    profileDraft(assistant.profiles[0], projects),
  );
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const selected = assistant.profiles.find((profile) => profile.id === selectedId);
  const turns = useMemo(
    () => assistant.turns.filter((turn) => turn.assistantId === selectedId),
    [assistant.turns, selectedId],
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
  const running = turns.some((turn) => turn.status === "queued" || turn.status === "running");
  const sessionOpen = selected ? assistant.openConversationIds.includes(selected.id) : false;
  const sessionResumable = selected
    ? (assistant.resumableConversationIds ?? []).includes(selected.id)
    : false;

  useEffect(() => {
    if (selectedId && assistant.profiles.some((profile) => profile.id === selectedId)) return;
    const next = assistant.profiles[0];
    setSelectedId(next?.id ?? null);
    setEditing(!next);
    setDraft(profileDraft(next, projects));
  }, [assistant.profiles, projects, selectedId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, turns.at(-1)?.status]);

  const choose = (profile: AssistantProfileRecord) => {
    setSelectedId(profile.id);
    setEditing(false);
    setDraft(profileDraft(profile, projects));
    setError(null);
  };

  const create = () => {
    setSelectedId(null);
    setEditing(true);
    setDraft(profileDraft(undefined, projects));
    setError(null);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const request: UpsertAssistantProfileRequest = {
      ...(selected ? { id: selected.id } : {}),
      ...draft,
      ...(draft.wecomBotProfileId
        ? { wecomBotProfileId: draft.wecomBotProfileId }
        : { wecomBotProfileId: undefined }),
    };
    try {
      const saved = await window.claudeWorkspace.upsertAssistantProfile(request);
      setSelectedId(saved.id);
      setDraft(profileDraft(saved, projects));
      setEditing(false);
    } catch (saveError) {
      setError(readableError(saveError));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || !message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.claudeWorkspace.sendAssistantMessage({
        assistantId: selected.id,
        text: message.trim(),
      });
      setMessage("");
    } catch (sendError) {
      setError(readableError(sendError));
    } finally {
      setBusy(false);
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
    }
  };

  return (
    <div className="assistant-backdrop" role="presentation">
      <section className="assistant-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-panel-title">
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
          <div className="assistant-list-note">本地与主人企微单聊共享一个会话；其他用户和所有群聊均静默忽略。</div>
        </aside>

        <main className="assistant-main">
          <header className="assistant-header">
            <div>
              <span className="automation-eyebrow">PERSONAL AGENT</span>
              <h2 id="assistant-panel-title">{editing ? selected ? `配置 ${selected.name}` : "新建私人助理" : selected?.name ?? "私人助理"}</h2>
              {!editing && selected ? <p>{sessionOpen ? "主人会话在线" : "主人会话已关闭"} · {tasks.length} 个定时任务 · {selected.wecomBotProfileId ? "企微已接入" : "仅本地"}</p> : null}
            </div>
            <div className="assistant-header-actions">
              {!editing && selected ? <button type="button" disabled={busy || running} onClick={() => { setDraft(profileDraft(selected, projects)); setEditing(true); }}>配置</button> : null}
              <button type="button" aria-label="关闭私人助理" onClick={onClose}>×</button>
            </div>
          </header>

          {error ? <div className="assistant-inline-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>×</button></div> : null}
          {editing ? (
            <form className="assistant-config assistant-config-form assistant-config-form--profile" onSubmit={saveProfile}>
              <div className="assistant-config-intro"><strong>保持简单</strong><span>选择工程、写一句助理定位，就可以开始对话。定时任务以后直接在聊天里告诉它。</span></div>
              <div className="assistant-config-grid">
                <label>助理名称<input required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
                <label>运行工程<select required value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.currentTarget.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.alias ?? project.name}</option>)}</select></label>
              </div>
              <label>它是谁<textarea rows={4} maxLength={4_000} placeholder="例如：作为我的私人研究助理，先给结论，再补充关键依据。" value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.currentTarget.value })} /></label>
              <section className="assistant-channel-card">
                <div><strong>企业微信入口（可选）</strong><span>只接受下方主人 userid 的单聊，不服务其他人和群聊。</span></div>
                <button type="button" onClick={() => setEntryDialogOpen(true)}>管理入口</button>
                <label>助理入口<select value={draft.wecomBotProfileId} onChange={(event) => setDraft({ ...draft, wecomBotProfileId: event.currentTarget.value })}><option value="">不绑定</option>{assistant.wecomBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} · {bot.status === "connected" ? "在线" : "未连接"}</option>)}</select></label>
                <label>主人 userid<input maxLength={200} placeholder="绑定入口时必填" disabled={Boolean(selected?.ownerWeComUserId)} value={draft.ownerWeComUserId} onChange={(event) => setDraft({ ...draft, ownerWeComUserId: event.currentTarget.value })} /></label>
              </section>
              <details className="assistant-advanced-settings">
                <summary>运行限制</summary>
                <div className="assistant-config-grid">
                  <label>单轮超时（分钟）<input type="number" min={1} max={120} value={draft.timeoutMinutes} onChange={(event) => setDraft({ ...draft, timeoutMinutes: Number(event.currentTarget.value) })} /></label>
                  <label>定时任务默认最大轮数<input type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => setDraft({ ...draft, maxTurns: Number(event.currentTarget.value) })} /></label>
                </div>
              </details>
              <label className="assistant-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />启用这个助理</label>
              <div className="assistant-permission-warning"><strong>主人拥有完整本机能力</strong><span>该助理可直接使用 Claude Code 的 Shell、文件、Chrome、Skills 和已配置 MCP。请保护系统登录与主人企业微信账号。</span></div>
              <div className="assistant-config-actions">
                {selected ? <button type="button" className="danger-button" disabled={busy} onClick={() => {
                  if (!window.confirm(`删除“${selected.name}”及客户端聊天、任务和运行记录？Claude Code 自身历史不会删除。`)) return;
                  void runSimpleAction(async () => { await window.claudeWorkspace.deleteAssistantProfile(selected.id); });
                }}>删除助理</button> : null}
                <button type="button" disabled={busy} onClick={() => { const fallback = selected ?? assistant.profiles[0]; setSelectedId(fallback?.id ?? null); setEditing(!fallback); setDraft(profileDraft(fallback, projects)); }}>取消</button>
                <button type="submit" className="primary-button" disabled={busy || !projects.length}>{selected ? "保存" : "创建助理"}</button>
              </div>
            </form>
          ) : selected ? (
            <>
              <nav className="assistant-tabs" aria-label="助理内容"><button type="button" className={tab === "chat" ? "assistant-tab assistant-tab--active" : "assistant-tab"} onClick={() => setTab("chat")}>主人聊天</button><button type="button" className={tab === "tasks" ? "assistant-tab assistant-tab--active" : "assistant-tab"} onClick={() => setTab("tasks")}>定时任务 <span>{tasks.length}</span></button></nav>
              {tab === "chat" ? (
                <>
                  <div className="assistant-session-actions">
                    <span>{sessionOpen ? "● Claude 会话常驻中" : sessionResumable ? "○ 会话已关闭，下条消息自动恢复" : "○ 尚未启动，下条消息创建会话"}</span>
                    <button type="button" disabled={busy || running || !sessionOpen} onClick={() => void runSimpleAction(() => window.claudeWorkspace.closeAssistantConversation(selected.id))}>关闭会话</button>
                    <button type="button" disabled={busy || running} onClick={() => {
                      if (window.confirm("开始新对话会清除客户端展示记录和已保存的 Claude 会话关联；定时任务不受影响。继续吗？")) void runSimpleAction(() => window.claudeWorkspace.resetAssistantConversation(selected.id));
                    }}>新对话</button>
                  </div>
                  <div className="assistant-messages">
                    {turns.length === 0 ? <div className="assistant-welcome"><span className="assistant-avatar assistant-avatar--large">{selected.name.slice(0, 1)}</span><h3>和 {selected.name} 开始对话</h3><p>你也可以直接说：“每个工作日 9 点帮我整理行业动态，有异常一定通知我。”</p></div> : turns.map((turn) => (
                      <div className="assistant-turn" key={turn.id}>
                        <article className="assistant-message assistant-message--user"><header><span>你</span><time>{shortTime(turn.createdAt)}</time></header><p>{turn.request}</p>{turn.source === "wecom" ? <small>来自企业微信</small> : null}</article>
                        <article className="assistant-message assistant-message--agent"><header><span>{selected.name}</span><small className={`assistant-turn-state assistant-turn-state--${turn.status}`}>{turnState(turn)}</small></header>{turn.response ? <MarkdownPreview content={turn.response} /> : turn.error ? <p className="assistant-message-error">{turn.error}</p> : <div className="assistant-thinking"><i /><i /><i /></div>}{turn.deliveryError ? <p className="assistant-delivery-error">{turn.deliveryError}</p> : null}</article>
                      </div>
                    ))}
                    <div ref={messageEndRef} />
                  </div>
                  <footer className="assistant-composer-wrap"><div className="assistant-composer"><textarea value={message} rows={2} maxLength={4_000} placeholder={selected.enabled ? `给 ${selected.name} 发消息，或让它创建定时任务…` : "这个助理已停用"} disabled={!selected.enabled || busy} onChange={(event) => setMessage(event.currentTarget.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />{running ? <button type="button" className="assistant-stop-button" disabled={busy} onClick={() => void runSimpleAction(() => window.claudeWorkspace.cancelAssistantTurn(selected.id))}>停止</button> : <button type="button" className="primary-button primary-button--compact" disabled={busy || !selected.enabled || !message.trim()} onClick={() => void send()}>发送</button>}</div><span>Enter 发送 · 主聊天保持常驻；每次定时任务运行使用独立的一次性会话</span></footer>
                </>
              ) : (
                <div className="assistant-task-view">
                  {assistant.schedulerError ? <div className="assistant-task-alert" role="alert"><strong>调度器异常</strong><span>{assistant.schedulerError}</span><small>{assistant.schedulerErrorAt ? shortTime(assistant.schedulerErrorAt) : null}</small></div> : null}
                  <div className={assistant.schedulerActive ? "assistant-scheduler-health" : "assistant-scheduler-health assistant-scheduler-health--stopped"}>
                    <span className={`status-dot ${assistant.schedulerActive ? "status-dot--online" : "status-dot--offline"}`} />
                    <strong>{assistant.schedulerActive ? "调度器运行中" : "调度器已停止"}</strong>
                    <small>{assistant.lastSchedulerCheckAt ? `最近检查 ${shortTime(assistant.lastSchedulerCheckAt)}` : "尚未完成首次检查"}</small>
                  </div>
                  <header className="assistant-task-heading"><div><h3>独立执行的定时任务</h3><p>在主人聊天里创建和修改；每次运行不读取主聊天历史，也不复用上一次任务会话。</p></div><button type="button" className="primary-button" onClick={() => { setTab("chat"); setMessage("请帮我创建一个定时任务："); }}>在聊天里创建</button></header>
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
      {entryDialogOpen ? <WeComEntryDialog bots={assistant.wecomBots} onClose={() => setEntryDialogOpen(false)} onSaved={(botProfileId) => setDraft({ ...draft, wecomBotProfileId: botProfileId })} /> : null}
    </div>
  );
}
