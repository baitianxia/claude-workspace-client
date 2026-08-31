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
  ProjectRecord,
  UpsertAutomationJobRequest,
} from "../shared/contracts";
import { projectDisplayName } from "./workspace-search";

interface AutomationPanelProps {
  automation: AutomationSnapshot;
  projects: ProjectRecord[];
  defaultWeComUserId?: string;
  onClose(): void;
}

interface JobDraft {
  name: string;
  enabled: boolean;
  projectId: string;
  schedule: string;
  mcpConfigPath: string;
  allowedMcpServers: string;
  prompt: string;
  emailRecipients: string;
  wecomTargetIds: string;
  allowedWecomUserIds: string;
  timeoutMinutes: string;
  maxTurns: string;
}

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

function draftForJob(
  job: AutomationJobRecord | undefined,
  projects: ProjectRecord[],
  defaultWeComUserId?: string,
): JobDraft {
  return job
    ? {
        name: job.name,
        enabled: job.enabled,
        projectId: job.projectId,
        schedule: job.schedule,
        mcpConfigPath: job.mcpConfigPath,
        allowedMcpServers: listText(job.allowedMcpServers),
        prompt: job.prompt,
        emailRecipients: listText(job.emailRecipients),
        wecomTargetIds: listText(job.wecomTargetIds),
        allowedWecomUserIds: listText(job.allowedWecomUserIds),
        timeoutMinutes: String(job.timeoutMinutes),
        maxTurns: String(job.maxTurns),
      }
    : {
        name: "",
        enabled: true,
        projectId: projects[0]?.id ?? "",
        schedule: "0 9 * * 1-5",
        mcpConfigPath: ".mcp.json",
        allowedMcpServers: "web\nmail",
        prompt: "",
        emailRecipients: "",
        wecomTargetIds: "",
        allowedWecomUserIds: defaultWeComUserId ?? "",
        timeoutMinutes: "20",
        maxTurns: "20",
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
  defaultWeComUserId,
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
  const selectedJob = automation.jobs.find((job) => job.id === selectedJobId);
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
    setError(null);
  };

  const createJob = () => {
    setSelectedJobId(null);
    setDraft(draftForJob(undefined, projects, defaultWeComUserId));
    setError(null);
  };

  const saveJob = (event: FormEvent) => {
    event.preventDefault();
    const request: UpsertAutomationJobRequest = {
      ...(selectedJobId ? { id: selectedJobId } : {}),
      name: draft.name,
      enabled: draft.enabled,
      projectId: draft.projectId,
      schedule: draft.schedule,
      mcpConfigPath: draft.mcpConfigPath,
      allowedMcpServers: parseList(draft.allowedMcpServers),
      prompt: draft.prompt,
      emailRecipients: parseList(draft.emailRecipients),
      wecomTargetIds: parseList(draft.wecomTargetIds),
      allowedWecomUserIds: parseList(draft.allowedWecomUserIds),
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
            <p>
              调度、运行记录和企微投递由客户端负责；网页读取与邮件发送由任务允许的
              MCP 完成。
            </p>
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
            任务配置 <span>{automation.jobs.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "runs"}
            className={tab === "runs" ? "automation-tab--active" : ""}
            onClick={() => setTab("runs")}
          >
            运行记录 <span>{automation.runs.length}</span>
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
                        <small>{job.schedule} · 本机时区</small>
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
                  <p>每次执行启动独立的无界面 Claude Code 进程。</p>
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
                <label>
                  <span>定时表达式（分 时 日 月 星期）</span>
                  <input
                    value={draft.schedule}
                    maxLength={100}
                    placeholder="0 9 * * 1-5"
                    onChange={(event) =>
                      setDraft({ ...draft, schedule: event.currentTarget.value })
                    }
                    required
                  />
                </label>
                <label>
                  <span>工程内 MCP 配置</span>
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
                  <span>最大 Agent 轮数</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={draft.maxTurns}
                    onChange={(event) =>
                      setDraft({ ...draft, maxTurns: event.currentTarget.value })
                    }
                    required
                  />
                </label>
              </div>

              <label className="automation-field">
                <span>允许的 MCP 服务器</span>
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
                <small>
                  只从上述配置文件复制这些服务器，并仅批准 `mcp__服务器名__*`。
                </small>
              </label>

              <label className="automation-field automation-prompt-field">
                <span>任务提示词</span>
                <textarea
                  rows={8}
                  value={draft.prompt}
                  maxLength={50_000}
                  placeholder="使用网页 MCP 检查指定页面，只保留符合条件的新信息……"
                  onChange={(event) =>
                    setDraft({ ...draft, prompt: event.currentTarget.value })
                  }
                  required
                />
              </label>

              <div className="automation-destination-grid">
                <label className="automation-field">
                  <span>固定邮件收件人</span>
                  <textarea
                    rows={3}
                    value={draft.emailRecipients}
                    placeholder="owner@example.com"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        emailRecipients: event.currentTarget.value,
                      })
                    }
                  />
                  <small>邮件 MCP 仍须在服务端独立执行同一白名单。</small>
                </label>
                <label className="automation-field">
                  <span>企业微信 userid / 群 chatid</span>
                  <textarea
                    rows={3}
                    value={draft.wecomTargetIds}
                    placeholder="wrxxxxxxxx"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        wecomTargetIds: event.currentTarget.value,
                      })
                    }
                  />
                  <small>在目标群 @机器人发送 `/chatid` 可查询本群 ID。</small>
                </label>
                <label className="automation-field">
                  <span>允许群内交互的 userid</span>
                  <textarea
                    rows={3}
                    value={draft.allowedWecomUserIds}
                    placeholder="zhangsan"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        allowedWecomUserIds: event.currentTarget.value,
                      })
                    }
                  />
                  <small>留空禁止群内执行；明确填写 `*` 才允许群内所有成员。</small>
                </label>
              </div>

              <div className="automation-form-note">
                内置 Shell、读写文件和浏览器工具均不提供给后台任务。任务采用普通 Claude
                Code 登录上下文启动，以兼容现有账号；独立 MCP 配置会按服务器名单过滤后临时加载。
              </div>

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
                  {busy ? "正在处理…" : "保存任务"}
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
