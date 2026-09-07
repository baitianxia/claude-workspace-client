/**
 * Claude Code has its own session/cloud scheduling tools. Private assistants
 * must use the app-owned assistant_tasks MCP instead so schedules survive in
 * the correct store and results are delivered by the assistant-bound bot.
 */
export const CLAUDE_NATIVE_SCHEDULING_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
] as const;
