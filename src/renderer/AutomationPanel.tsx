import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type {
  AutomationJobRecord,
  AutomationRunRecord,
  AutomationSnapshot,
  DiscoveredWeComGroup,
  ProjectRecord,
  UpsertAutomationJobRequest,
  WeComState,
} from "../shared/contracts";
import {
  automationScheduleExpression,
  automationScheduleFields,
  automationScheduleLabel,
  type AutomationScheduleMode,
} from "./automation-schedule";
import { projectDisplayName } from "./workspace-search";

interface AutomationPanelProps {
  automation: AutomationSnapshot;
  projects: ProjectRecord[];
  wecom: WeComState;
  defaultWeComUserId?: string;
  onConfigureWeCom(): void;
  onClose(): void;
}

interface JobDraft {
  name: string;
  enabled: boolean;
  projectId: string;
  scheduleMode: AutomationScheduleMode;
  scheduleTime: string;
  schedule: string;
  mcpConfigPath: string;
  allowedMcpServers: string;
  prompt: string;
  emailRecipients: string;
  wecomTargetIds: string;
  allowedWecomUserIds: string;
  timeoutMinutes: string;
  maxTurns: string;
  deliveryChannels: DeliveryChannel[];
}

type DeliveryChannel = "wecom" | "email";

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function listText(values: string[]): string {
  return values.join("\n");
}

function parseList(value: string): string[] {
  return value
    .split(/[,，;；\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shortWeComTargetId(value: string): string {
  return value.length <= 18
    ? value
    : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function discoveredGroupLabel(group: DiscoveredWeComGroup): string {
  return `${group.alias || "未命名群"} · ${shortWeComTargetId(group.chatId)}`;
}

function wecomConnectionLabel(wecom: WeComState): string {
  if (!wecom.configured) {
    return "尚未配置";
  }
  switch (wecom.status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "正在连接";
    case "disabled":
      return "已停用";
    case "error":
      return "连接异常";
  }
}

function deliveryChannelsForJob(
  job: AutomationJobRecord | undefined,
): DeliveryChannel[] {
  if (!job) {
    return ["wecom"];
  }
  const channels: DeliveryChannel[] = [];
  if (job.wecomTargetIds.length) {
    channels.push("wecom");
  }
  if (job.emailRecipients.length) {
    channels.push("email");
  }
  return channels;
}

function draftForJob(
  job: AutomationJobRecord | undefined,
  projects: ProjectRecord[],
  defaultWeComUserId?: string,
): JobDraft {
  const schedule = job?.schedule ?? "0 9 * * 1-5";
  const scheduleFields = automationScheduleFields(schedule);
  return job
    ? {
        name: job.name,
        enabled: job.enabled,
        projectId: job.projectId,
        scheduleMode: scheduleFields.mode,
        scheduleTime: scheduleFields.time,
        schedule,
        mcpConfigPath: job.mcpConfigPath,
        allowedMcpServers: listText(job.allowedMcpServers),
        prompt: job.prompt,
        emailRecipients: listText(job.emailRecipients),
        wecomTargetIds: listText(job.wecomTargetIds),
        allowedWecomUserIds: listText(job.allowedWecomUserIds),
        timeoutMinutes: String(job.timeoutMinutes),
        maxTurns: String(job.maxTurns),
        deliveryChannels: deliveryChannelsForJob(job),
      }
    : {
        name: "",
        enabled: true,
        projectId: projects[0]?.id ?? "",
        scheduleMode: scheduleFields.mode,
        scheduleTime: scheduleFields.time,
        schedule,
        mcpConfigPath: ".mcp.json",
        allowedMcpServers: "web\nmail",
        prompt: "",
        emailRecipients: "",
        wecomTargetIds: "",
        allowedWecomUserIds: defaultWeComUserId ?? "",
        timeoutMinutes: "20",
        maxTurns: "20",
        deliveryChannels: deliveryChannelsForJob(undefined),
      };
}

function runStatusLabel(status: AutomationRunRecord["status"]): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "timed-out":
      return "已超时";
    case "cancelled":
      return "已取消";
    case "skipped":
      return "已跳过";
  }
}

function triggerLabel(trigger: AutomationRunRecord["trigger"]): string {
  switch (trigger) {
    case "manual":
      return "手动";
    case "scheduled":
      return "定时";
    case "wecom":
      return "企微";
  }
}

function emailStatusLabel(
  status: NonNullable<AutomationRunRecord["result"]>["email"]["status"],
): string {
  switch (status) {
    case "not-requested":
      return "未请求";
    case "sent":
      return "已发送";
    case "failed":
      return "发送失败";
  }
}

function deliveryStatusLabel(
  status: AutomationRunRecord["deliveries"][number]["status"],
): string {
  switch (status) {
    case "pending":
      return "待投递";
    case "sending":
      return "投递中";
    case "sent":
      return "已投递";
    case "failed":
      return "投递失败";
    case "skipped":
      return "已跳过";
  }
}

function safeEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function dateTime(value: number | undefined): string {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
}

export function AutomationPanel({
  automation,
  projects,
  wecom,
  defaultWeComUserId,
  onConfigureWeCom,
  onClose,
}: AutomationPanelProps) {
  const initialJob = automation.jobs[0];
  const [tab, setTab] = useState<"jobs" | "runs">("jobs");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    initialJob?.id ?? null,
  );
  const [draft, setDraft] = useState(() =>
    draftForJob(initialJob, projects, defaultWeComUserId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDiscoveredGroupId, setSelectedDiscoveredGroupId] =
    useState("");
  const [editingGroupAlias, setEditingGroupAlias] = useState(false);
  const [groupAliasDraft, setGroupAliasDraft] = useState("");
  const [manualWeComTarget, setManualWeComTarget] = useState("");
  const [manualWeComTargetOpen, setManualWeComTargetOpen] = useState(
    !automation.discoveredWeComGroups.length,
  );
  const selectedJob = automation.jobs.find((job) => job.id === selectedJobId);
  const selectedWeComTargetIds = useMemo(
    () => parseList(draft.wecomTargetIds),
    [draft.wecomTargetIds],
  );
  const selectedDiscoveredGroup = automation.discoveredWeComGroups.find(
    (group) => group.chatId === selectedDiscoveredGroupId,
  );
  const runsByJob = useMemo(() => {
    const grouped = new Map<string, AutomationRunRecord[]>();
    for (const run of automation.runs) {
      const runs = grouped.get(run.jobId) ?? [];
      runs.push(run);
      grouped.set(run.jobId, runs);
    }
    return grouped;
  }, [automation.runs]);

  useEffect(() => {
    if (
      selectedJobId &&
      !automation.jobs.some((job) => job.id === selectedJobId)
    ) {
      const next = automation.jobs[0];
      setSelectedJobId(next?.id ?? null);
      setDraft(draftForJob(next, projects, defaultWeComUserId));
    }
  }, [automation.jobs, defaultWeComUserId, projects, selectedJobId]);

  const runAction = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (actionError) {
      setError(readableError(actionError));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const selectJob = (job: AutomationJobRecord) => {
    setSelectedJobId(job.id);
    setDraft(draftForJob(job, projects, defaultWeComUserId));
    setSelectedDiscoveredGroupId("");
    setEditingGroupAlias(false);
    setManualWeComTarget("");
    setManualWeComTargetOpen(!automation.discoveredWeComGroups.length);
    setError(null);
  };

  const createJob = () => {
    setSelectedJobId(null);
    setDraft(draftForJob(undefined, projects, defaultWeComUserId));
    setSelectedDiscoveredGroupId("");
    setEditingGroupAlias(false);
    setManualWeComTarget("");
    setManualWeComTargetOpen(!automation.discoveredWeComGroups.length);
    setError(null);
  };

  const addWeComTargets = (targetIds: string[]) => {
    setDraft((current) => {
      const next = parseList(current.wecomTargetIds);
      const known = new Set(
        next.map((targetId) => targetId.toLocaleLowerCase("en-US")),
      );
      for (const targetId of targetIds) {
        const normalized = targetId.trim();
        const key = normalized.toLocaleLowerCase("en-US");
        if (normalized && !known.has(key)) {
          known.add(key);
          next.push(normalized);
        }
      }
      return { ...current, wecomTargetIds: listText(next) };
    });
  };

  const removeWeComTarget = (targetId: string) => {
    setDraft((current) => ({
      ...current,
      wecomTargetIds: listText(
        parseList(current.wecomTargetIds).filter(
          (candidate) => candidate !== targetId,
        ),
      ),
    }));
  };

  const addSelectedDiscoveredGroup = () => {
    if (selectedDiscoveredGroupId) {
      addWeComTargets([selectedDiscoveredGroupId]);
    }
  };

  const addManualWeComTargets = () => {
    const targetIds = parseList(manualWeComTarget);
    if (!targetIds.length) {
      setError("请先填写企业微信 userid 或群 chatid。");
      return;
    }
    addWeComTargets(targetIds);
    setManualWeComTarget("");
    setError(null);
  };

  const saveGroupAlias = () => {
    if (!selectedDiscoveredGroup) {
      return;
    }
    void runAction(() =>
      window.claudeWorkspace.updateAutomationWeComGroupAlias({
        chatId: selectedDiscoveredGroup.chatId,
        alias: groupAliasDraft,
      }),
    ).then((saved) => {
      if (saved) {
        setGroupAliasDraft(saved.alias ?? "");
        setEditingGroupAlias(false);
      }
    });
  };

  const toggleDeliveryChannel = (channel: DeliveryChannel) => {
    setDraft((current) => ({
      ...current,
      deliveryChannels: current.deliveryChannels.includes(channel)
        ? current.deliveryChannels.filter((value) => value !== channel)
        : [...current.deliveryChannels, channel],
    }));
  };

  const saveJob = (event: FormEvent) => {
    event.preventDefault();
    const wecomTargetIds = parseList(draft.wecomTargetIds);
    if (
      draft.deliveryChannels.includes("wecom") &&
      wecomTargetIds.length === 0
    ) {
      setError("请选择至少一个企业微信接收群，或手动添加接收目标。");
      return;
    }
    const request: UpsertAutomationJobRequest = {
      ...(selectedJobId ? { id: selectedJobId } : {}),
      name: draft.name,
      enabled: draft.enabled,
      projectId: draft.projectId,
      schedule: automationScheduleExpression(
        draft.scheduleMode,
        draft.scheduleTime,
        draft.schedule,
      ),
      mcpConfigPath: draft.mcpConfigPath,
      allowedMcpServers: parseList(draft.allowedMcpServers),
      prompt: draft.prompt,
      emailRecipients: draft.deliveryChannels.includes("email")
        ? parseList(draft.emailRecipients)
        : [],
      wecomTargetIds: draft.deliveryChannels.includes("wecom")
        ? wecomTargetIds
        : [],
      allowedWecomUserIds: draft.deliveryChannels.includes("wecom")
        ? parseList(draft.allowedWecomUserIds)
        : [],
      timeoutMinutes: Number(draft.timeoutMinutes),
      maxTurns: Number(draft.maxTurns),
    };
    void runAction(() => window.claudeWorkspace.upsertAutomationJob(request)).then(
      (saved) => {
        if (saved) {
          setSelectedJobId(saved.id);
          setDraft(draftForJob(saved, projects, defaultWeComUserId));
        }
      },
    );
  };

  const deleteJob = () => {
    if (
      !selectedJob ||
      !window.confirm(`确认删除自动化任务“${selectedJob.name}”？运行历史会保留。`)
    ) {
      return;
    }
    void runAction(() =>
      window.claudeWorkspace.deleteAutomationJob(selectedJob.id),
    );
  };

  const runNow = () => {
    if (selectedJob) {
      void runAction(() =>
        window.claudeWorkspace.runAutomationJob(selectedJob.id),
      );
    }
  };

  return (
    <div className="automation-backdrop" role="presentation">
      <section
        className="automation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-title"
      >
        <header className="automation-header">
          <div>
            <span className="automation-eyebrow">CLAUDE CODE + MCP</span>
            <h2 id="automation-title">网页信息推送自动化</h2>
            <p>定时读取网页，把新信息推送到企业微信或邮箱。</p>
          </div>
          <button type="button" aria-label="关闭自动化管理" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="automation-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "jobs"}
            className={tab === "jobs" ? "automation-tab--active" : ""}
            onClick={() => setTab("jobs")}
          >
            任务 <span>{automation.jobs.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "runs"}
            className={tab === "runs" ? "automation-tab--active" : ""}
            onClick={() => setTab("runs")}
          >
            记录 <span>{automation.runs.length}</span>
          </button>
          <div className="automation-scheduler-state">
            <span
              className={`status-dot ${automation.schedulerActive ? "status-dot--online" : "status-dot--offline"}`}
            />
            {automation.schedulerActive ? "本地调度器运行中" : "本地调度器已停止"}
          </div>
        </div>

        {error ? (
          <div className="automation-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
              ×
            </button>
          </div>
        ) : null}

        {tab === "jobs" ? (
          <div className="automation-jobs-layout">
            <aside className="automation-job-list">
              <div className="automation-list-heading">
                <strong>自动化任务</strong>
                <button type="button" onClick={createJob} disabled={busy}>
                  ＋ 新建
                </button>
              </div>
              {automation.jobs.length ? (
                automation.jobs.map((job) => {
                  const latest = runsByJob.get(job.id)?.[0];
                  const running = automation.runningJobIds.includes(job.id);
                  return (
                    <button
                      type="button"
                      key={job.id}
                      className={`automation-job-row ${selectedJobId === job.id ? "automation-job-row--selected" : ""}`}
                      onClick={() => selectJob(job)}
                    >
                      <span
                        className={`status-dot ${running ? "status-dot--pending" : job.enabled ? "status-dot--online" : "status-dot--offline"}`}
                      />
                      <span>
                        <strong>{job.name}</strong>
                        <small>
                          {automationScheduleLabel(job.schedule)} · 本机时区
                        </small>
                        <small>
                          {running
                            ? "正在运行"
                            : latest
                              ? `${runStatusLabel(latest.status)} · ${dateTime(latest.finishedAt ?? latest.createdAt)}`
                              : "尚未运行"}
                        </small>
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="automation-empty-list">还没有自动化任务。</div>
              )}
            </aside>

            <form className="automation-job-form" onSubmit={saveJob}>
              <div className="automation-form-heading">
                <div>
                  <h3>{selectedJob ? selectedJob.name : "新建自动化任务"}</h3>
                  <p>设置执行时间、任务内容和推送目标。</p>
                </div>
                <label className="automation-inline-toggle">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) =>
                      setDraft({ ...draft, enabled: event.currentTarget.checked })
                    }
                  />
                  启用定时触发
                </label>
              </div>

              {!projects.length ? (
                <div className="automation-warning">
                  请先在主界面添加工程，任务需要以工程目录作为 Claude Code 工作目录。
                </div>
              ) : null}

              <div className="automation-form-grid">
                <label>
                  <span>任务名称</span>
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.currentTarget.value })
                    }
                    required
                  />
                </label>
                <label>
                  <span>运行工程</span>
                  <select
                    value={draft.projectId}
                    onChange={(event) =>
                      setDraft({ ...draft, projectId: event.currentTarget.value })
                    }
                    required
                  >
                    <option value="" disabled>
                      选择工程
                    </option>
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {projectDisplayName(project)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="automation-schedule-block">
                <span className="automation-section-label">执行时间</span>
                <div className="automation-schedule-controls">
                  <label>
                    <span className="visually-hidden">执行频率</span>
                    <select
                      aria-label="执行频率"
                      value={draft.scheduleMode}
                      onChange={(event) => {
                        const scheduleMode = event.currentTarget
                          .value as AutomationScheduleMode;
                        setDraft((current) => ({
                          ...current,
                          schedule:
                            scheduleMode === "custom"
                              ? automationScheduleExpression(
                                  current.scheduleMode,
                                  current.scheduleTime,
                                  current.schedule,
                                )
                              : current.schedule,
                          scheduleMode,
                        }));
                      }}
                    >
                      <option value="weekdays">每个工作日</option>
                      <option value="daily">每天</option>
                      <option value="custom">自定义</option>
                    </select>
                  </label>
                  {draft.scheduleMode === "custom" ? (
                    <label>
                      <span className="visually-hidden">Cron 表达式</span>
                      <input
                        aria-label="Cron 表达式"
                        value={draft.schedule}
                        maxLength={100}
                        placeholder="0 9 * * 1-5"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            schedule: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                  ) : (
                    <label>
                      <span className="visually-hidden">执行时间</span>
                      <input
                        aria-label="执行时间"
                        type="time"
                        value={draft.scheduleTime}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            scheduleTime: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                  )}
                </div>
                <small>按本机时区执行；复杂计划可选择“自定义”。</small>
              </div>

              <label className="automation-field automation-prompt-field">
                <span>任务内容</span>
                <textarea
                  rows={4}
                  value={draft.prompt}
                  maxLength={50_000}
                  placeholder="例如：检查行业资讯页面，只整理新出现且与业务相关的信息。"
                  onChange={(event) =>
                    setDraft({ ...draft, prompt: event.currentTarget.value })
                  }
                  required
                />
              </label>

              <fieldset className="automation-channel-section">
                <legend>推送到</legend>
                <div className="automation-channel-picker">
                  <button
                    type="button"
                    aria-pressed={draft.deliveryChannels.includes("wecom")}
                    className={
                      draft.deliveryChannels.includes("wecom")
                        ? "automation-channel-option automation-channel-option--selected"
                        : "automation-channel-option"
                    }
                    onClick={() => toggleDeliveryChannel("wecom")}
                  >
                    <span>企</span>
                    <span>
                      <strong>企业微信</strong>
                      <small>个人或群聊</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={draft.deliveryChannels.includes("email")}
                    className={
                      draft.deliveryChannels.includes("email")
                        ? "automation-channel-option automation-channel-option--selected"
                        : "automation-channel-option"
                    }
                    onClick={() => toggleDeliveryChannel("email")}
                  >
                    <span>邮</span>
                    <span>
                      <strong>邮件</strong>
                      <small>固定收件人</small>
                    </span>
                  </button>
                </div>

                {draft.deliveryChannels.includes("wecom") ? (
                  <div
                    className={`automation-wecom-sender automation-wecom-sender--${wecom.status}`}
                  >
                    <div>
                      <span
                        className={`status-dot ${
                          wecom.status === "connected"
                            ? "status-dot--online"
                            : wecom.status === "connecting"
                              ? "status-dot--pending"
                              : "status-dot--offline"
                        }`}
                      />
                      <span>
                        <strong>发送机器人</strong>
                        <small
                          title={
                            wecom.error ||
                            (wecom.configured
                              ? `Bot ID ${wecom.botId}`
                              : undefined)
                          }
                        >
                          {wecom.configured
                            ? `${wecomConnectionLabel(wecom)} · Bot ID ${wecom.botId}`
                            : "尚未配置 Bot ID 与 Secret"}
                        </small>
                        <small>所有自动化任务共用这个机器人连接</small>
                      </span>
                    </div>
                    <button type="button" onClick={onConfigureWeCom}>
                      {wecom.configured ? "修改机器人" : "配置机器人"}
                    </button>
                  </div>
                ) : null}

                {draft.deliveryChannels.length ? (
                  <div className="automation-destination-grid">
                    {draft.deliveryChannels.includes("wecom") ? (
                      <div className="automation-field automation-wecom-target-field">
                        <span>企业微信接收群</span>
                        <div className="automation-wecom-group-picker">
                          <select
                            aria-label="选择已发现的企业微信群"
                            value={selectedDiscoveredGroupId}
                            disabled={!automation.discoveredWeComGroups.length}
                            onChange={(event) => {
                              const chatId = event.currentTarget.value;
                              const group = automation.discoveredWeComGroups.find(
                                (candidate) => candidate.chatId === chatId,
                              );
                              setSelectedDiscoveredGroupId(chatId);
                              setGroupAliasDraft(group?.alias ?? "");
                              setEditingGroupAlias(false);
                            }}
                          >
                            <option value="">
                              {automation.discoveredWeComGroups.length
                                ? "选择已发现的群"
                                : "还没有发现群"}
                            </option>
                            {automation.discoveredWeComGroups.map((group) => (
                              <option value={group.chatId} key={group.chatId}>
                                {discoveredGroupLabel(group)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={addSelectedDiscoveredGroup}
                            disabled={
                              busy ||
                              !selectedDiscoveredGroupId ||
                              selectedWeComTargetIds.includes(
                                selectedDiscoveredGroupId,
                              )
                            }
                          >
                            添加
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingGroupAlias(true)}
                            disabled={busy || !selectedDiscoveredGroup}
                          >
                            设置名称
                          </button>
                        </div>

                        {editingGroupAlias && selectedDiscoveredGroup ? (
                          <div className="automation-wecom-alias-editor">
                            <input
                              aria-label="企业微信群名称"
                              value={groupAliasDraft}
                              maxLength={80}
                              placeholder="例如：每日资讯群"
                              onChange={(event) =>
                                setGroupAliasDraft(event.currentTarget.value)
                              }
                            />
                            <button
                              type="button"
                              onClick={saveGroupAlias}
                              disabled={busy}
                            >
                              保存名称
                            </button>
                          </div>
                        ) : null}

                        <div
                          className="automation-wecom-target-list"
                          aria-label="已选企业微信接收目标"
                        >
                          {selectedWeComTargetIds.length ? (
                            selectedWeComTargetIds.map((targetId) => {
                              const group = automation.discoveredWeComGroups.find(
                                (candidate) => candidate.chatId === targetId,
                              );
                              return (
                                <span
                                  className="automation-wecom-target-chip"
                                  key={targetId}
                                  title={targetId}
                                >
                                  <span>
                                    {group
                                      ? discoveredGroupLabel(group)
                                      : shortWeComTargetId(targetId)}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`移除企业微信接收目标 ${targetId}`}
                                    onClick={() => removeWeComTarget(targetId)}
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })
                          ) : (
                            <span className="automation-wecom-target-empty">
                              尚未选择接收群
                            </span>
                          )}
                        </div>

                        <details
                          className="automation-wecom-manual-target"
                          open={manualWeComTargetOpen}
                          onToggle={(event) =>
                            setManualWeComTargetOpen(event.currentTarget.open)
                          }
                        >
                          <summary>手动填写 userid 或群 chatid</summary>
                          <div>
                            <input
                              aria-label="手动填写企业微信接收目标"
                              value={manualWeComTarget}
                              placeholder="多个目标可用逗号分隔"
                              onChange={(event) =>
                                setManualWeComTarget(event.currentTarget.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addManualWeComTargets();
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={addManualWeComTargets}
                              disabled={busy}
                            >
                              添加
                            </button>
                          </div>
                        </details>
                        <small>
                          目标群首次 @机器人发送 `/chatid` 后会自动出现；群名称只保存在本机。
                        </small>
                      </div>
                    ) : null}
                    {draft.deliveryChannels.includes("email") ? (
                      <label className="automation-field">
                        <span>邮件收件人</span>
                        <textarea
                          className="automation-compact-list-input"
                          rows={1}
                          value={draft.emailRecipients}
                          placeholder="owner@example.com，多个用逗号分隔"
                          required
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              emailRecipients: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className="automation-channel-empty">暂不推送，仅保留运行记录。</p>
                )}
              </fieldset>

              <details className="automation-advanced-settings">
                <summary>
                  <span>
                    <strong>高级设置</strong>
                    <small>MCP、安全与执行限制</small>
                  </span>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <div className="automation-advanced-body">
                  <div className="automation-form-grid">
                    <label>
                      <span>MCP 配置文件</span>
                      <input
                        value={draft.mcpConfigPath}
                        maxLength={500}
                        placeholder=".mcp.json"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            mcpConfigPath: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                    <label>
                      <span>允许的 MCP 服务</span>
                      <textarea
                        rows={2}
                        value={draft.allowedMcpServers}
                        placeholder="web&#10;mail"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            allowedMcpServers: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                    <label>
                      <span>超时（分钟）</span>
                      <input
                        type="number"
                        min={1}
                        max={120}
                        value={draft.timeoutMinutes}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            timeoutMinutes: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                    <label>
                      <span>最大执行轮数</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={draft.maxTurns}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            maxTurns: event.currentTarget.value,
                          })
                        }
                        required
                      />
                    </label>
                  </div>

                  {draft.deliveryChannels.includes("wecom") ? (
                    <label className="automation-field">
                      <span>允许通过企微触发任务的用户</span>
                      <textarea
                        rows={2}
                        value={draft.allowedWecomUserIds}
                        placeholder="userid；留空表示不允许远程触发"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            allowedWecomUserIds: event.currentTarget.value,
                          })
                        }
                      />
                      <small>明确填写 `*` 才允许群内所有成员。</small>
                    </label>
                  ) : null}

                  <div className="automation-form-note">
                    后台任务只加载这里允许的 MCP 服务，不提供内置 Shell、文件读写或浏览器工具。
                  </div>
                </div>
              </details>

              <footer className="automation-form-actions">
                {selectedJob ? (
                  <button
                    className="automation-danger-button"
                    type="button"
                    onClick={deleteJob}
                    disabled={busy || automation.runningJobIds.includes(selectedJob.id)}
                  >
                    删除任务
                  </button>
                ) : null}
                <span />
                {selectedJob ? (
                  <button
                    className="settings-secondary-button"
                    type="button"
                    onClick={runNow}
                    disabled={
                      busy ||
                      automation.runningJobIds.includes(selectedJob.id) ||
                      !projects.length
                    }
                  >
                    立即运行
                  </button>
                ) : null}
                <button
                  className="primary-button primary-button--compact"
                  type="submit"
                  disabled={busy || !projects.length}
                >
                  {busy ? "正在处理…" : "保存"}
                </button>
              </footer>
            </form>
          </div>
        ) : (
          <div className="automation-runs">
            {automation.runs.length ? (
              automation.runs.map((run) => {
                const canRetry =
                  run.status === "failed" ||
                  run.status === "timed-out" ||
                  run.status === "cancelled";
                const active = run.status === "queued" || run.status === "running";
                return (
                  <article className="automation-run-card" key={run.id}>
                    <header>
                      <div>
                        <span className={`automation-run-status automation-run-status--${run.status}`}>
                          {runStatusLabel(run.status)}
                        </span>
                        <strong>{run.jobName}</strong>
                        <code>[RPT-{run.reportCode}]</code>
                      </div>
                      <span>
                        {triggerLabel(run.trigger)} · {dateTime(run.startedAt ?? run.createdAt)}
                      </span>
                    </header>
                    <div className="automation-run-body">
                      <p>
                        {run.result?.summary || run.error || "等待 Claude Code 返回结果。"}
                      </p>
                      {run.result ? (
                        <div className="automation-run-meta">
                          <span>
                            结果：{run.result.outcome === "notify" ? "需要通知" : "无变化"}
                          </span>
                          <span>
                            邮件：{emailStatusLabel(run.result.email.status)}
                          </span>
                          <span>证据：{run.result.evidence.length}</span>
                          <span>尝试：{run.attempt}</span>
                        </div>
                      ) : null}
                      {run.deliveries.length ? (
                        <div className="automation-deliveries">
                          {run.deliveries.map((delivery) => (
                            <span key={delivery.targetId} title={delivery.error}>
                              {delivery.targetId} · {deliveryStatusLabel(delivery.status)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {run.result &&
                      (run.result.wecomMarkdown ||
                        run.result.evidence.length > 0 ||
                        run.result.email.detail) ? (
                        <details className="automation-run-result-details">
                          <summary>查看报告、邮件结果与来源</summary>
                          {run.result.wecomMarkdown ? (
                            <pre>{run.result.wecomMarkdown}</pre>
                          ) : null}
                          {run.result.email.detail ? (
                            <p>
                              邮件执行说明：{run.result.email.detail}
                            </p>
                          ) : null}
                          {run.result.evidence.length ? (
                            <ul>
                              {run.result.evidence.map((evidence, index) => {
                                const url = safeEvidenceUrl(evidence.url);
                                return (
                                  <li key={`${evidence.url}-${index}`}>
                                    {url ? (
                                      <a
                                        href={url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {evidence.title || url}
                                      </a>
                                    ) : (
                                      <span>{evidence.title || "无效来源链接"}</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </details>
                      ) : null}
                      {run.diagnostic ? (
                        <details>
                          <summary>诊断信息</summary>
                          <pre>{run.diagnostic}</pre>
                        </details>
                      ) : null}
                    </div>
                    <footer>
                      {active ? (
                        <button
                          type="button"
                          className="automation-danger-button"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              window.claudeWorkspace.cancelAutomationRun(run.id),
                            )
                          }
                        >
                          取消执行
                        </button>
                      ) : null}
                      {canRetry ? (
                        <button
                          type="button"
                          className="settings-secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void runAction(() =>
                              window.claudeWorkspace.retryAutomationRun(run.id),
                            )
                          }
                        >
                          使用同一幂等键重试
                        </button>
                      ) : null}
                    </footer>
                  </article>
                );
              })
            ) : (
              <div className="automation-runs-empty">
                <strong>还没有运行记录</strong>
                <span>保存任务后可立即运行，或等待本机定时器触发。</span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
