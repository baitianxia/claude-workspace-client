import type { AutomationJobRecord } from "../shared/contracts";
import {
  matchesParsedCronSchedule,
  parseCronSchedule,
  type ParsedCronSchedule,
} from "./cron-schedule";

const CHECK_INTERVAL_MILLISECONDS = 15_000;
const MAX_CATCH_UP_MINUTES = 60;

export class ScheduledJobService {
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedMinute: number | null = null;
  private lastCheckedAt: number | undefined;
  private readonly parsedSchedules = new Map<string, ParsedCronSchedule>();
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(
    private readonly listJobs: () => AutomationJobRecord[],
    private readonly trigger: (
      job: AutomationJobRecord,
      scheduledFor: number,
    ) => Promise<void>,
    private readonly onChecked: (checkedAt: number) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const currentMinute = Math.floor(this.now() / 60_000);
    this.lastCheckedMinute = currentMinute - 1;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), CHECK_INTERVAL_MILLISECONDS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async settle(): Promise<void> {
    while (this.activeTicks.size > 0) {
      await Promise.allSettled([...this.activeTicks]);
    }
  }

  isActive(): boolean {
    return this.timer !== null;
  }

  getLastCheckedAt(): number | undefined {
    return this.lastCheckedAt;
  }

  async tick(at = this.now()): Promise<void> {
    const currentMinute = Math.floor(at / 60_000);
    if (this.lastCheckedMinute === null || currentMinute < this.lastCheckedMinute) {
      this.lastCheckedMinute = currentMinute - 1;
    }
    if (currentMinute === this.lastCheckedMinute) {
      return;
    }
    const firstMinute = Math.max(
      this.lastCheckedMinute + 1,
      currentMinute - MAX_CATCH_UP_MINUTES + 1,
    );
    this.lastCheckedMinute = currentMinute;
    this.lastCheckedAt = at;
    this.onChecked(at);

    for (const job of this.listJobs()) {
      if (!job.enabled) {
        continue;
      }
      let schedule: ParsedCronSchedule;
      try {
        schedule =
          this.parsedSchedules.get(job.schedule) ??
          parseCronSchedule(job.schedule);
        this.parsedSchedules.set(job.schedule, schedule);
      } catch (error) {
        console.error(`Invalid automation schedule for ${job.id}`, error);
        continue;
      }
      let latestMatch: number | undefined;
      for (let minute = firstMinute; minute <= currentMinute; minute += 1) {
        const timestamp = minute * 60_000;
        if (matchesParsedCronSchedule(schedule, new Date(timestamp))) {
          latestMatch = timestamp;
        }
      }
      if (latestMatch !== undefined) {
        await this.trigger(job, latestMatch);
      }
    }
  }

  private runTick(): void {
    let tracked: Promise<void>;
    tracked = this.tick()
      .catch((error: unknown) => {
        console.error("Scheduled automation check failed", error);
      })
      .finally(() => {
        this.activeTicks.delete(tracked);
      });
    this.activeTicks.add(tracked);
  }
}
