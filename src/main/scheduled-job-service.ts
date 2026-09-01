import {
  matchesParsedCronSchedule,
  parseCronSchedule,
  type ParsedCronSchedule,
} from "./cron-schedule";

export interface ScheduledItem {
  id: string;
  enabled: boolean;
  schedule: string;
}

const CHECK_INTERVAL_MILLISECONDS = 15_000;
const MAX_CATCH_UP_MINUTES = 60;

export class ScheduledJobService {
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedMinute: number | null = null;
  private lastCheckedAt: number | undefined;
  private readonly parsedSchedules = new Map<string, ParsedCronSchedule>();
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(
    private readonly listJobs: () => ScheduledItem[],
    private readonly trigger: (
      job: ScheduledItem,
      scheduledFor: number,
    ) => Promise<void>,
    private readonly onChecked: (checkedAt: number) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown, itemId?: string) => void = () =>
      undefined,
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
        console.error(`Invalid assistant task schedule for ${job.id}`, error);
        this.onError(error, job.id);
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
        try {
          await this.trigger(job, latestMatch);
        } catch (error) {
          console.error(`Failed to trigger assistant task ${job.id}`, error);
          this.onError(error, job.id);
        }
      }
    }
  }

  private runTick(): void {
    let tracked: Promise<void>;
    tracked = this.tick()
      .catch((error: unknown) => {
        console.error("Scheduled assistant task check failed", error);
        this.onError(error);
      })
      .finally(() => {
        this.activeTicks.delete(tracked);
      });
    this.activeTicks.add(tracked);
  }
}
