import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { AppConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface ScheduledJobState {
  id: string;
  jobName: string;
  intervalMinutes: number;
  isPaused: boolean;
  isRunning: boolean;
  consecutiveFailures: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  dailySpendUsd: number;
  spendResetDate: string;
  updatedAt: string;
}

export interface JobExecutionResult {
  spendUsd: number;
  recordsProcessed: number;
}

/**
 * Local SQLite-backed Job Scheduler (Section 12):
 * - Configurable scan frequency.
 * - Persistent job history and state in `scheduled_jobs`.
 * - Prevents duplicate overlapping jobs (`is_running` lock).
 * - Retry and recovery behavior with consecutive failure tracking.
 * - Spend and volume limits (`MAX_DAILY_ESTIMATED_SPEND_USD`).
 * - Manual pause switch (`pauseJob` / `resumeJob`).
 * - Alerts when collection fails repeatedly (>= 3 consecutive failures).
 */
export class SchedulerService {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Database.Database,
    private readonly config: AppConfig,
    private readonly onAlert?: (jobName: string, message: string) => void
  ) {}

  registerOrUpdateJob(jobName: string, intervalMinutes: number): ScheduledJobState {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();

    const existing = this.getJobState(jobName);
    if (existing) {
      this.db
        .prepare(
          'UPDATE scheduled_jobs SET interval_minutes = ?, updated_at = ? WHERE job_name = ?'
        )
        .run(intervalMinutes, now, jobName);
      return this.getJobState(jobName)!;
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO scheduled_jobs (
          id, job_name, interval_minutes, is_paused, is_running,
          consecutive_failures, last_run_at, next_run_at, last_status,
          last_error, daily_spend_usd, spend_reset_date, updated_at
        ) VALUES (?, ?, ?, 0, 0, 0, NULL, ?, 'registered', NULL, 0, ?, ?)`
      )
      .run(id, jobName, intervalMinutes, nextRunAt, today, now);

    return this.getJobState(jobName)!;
  }

  getJobState(jobName: string): ScheduledJobState | null {
    const row = this.db
      .prepare('SELECT * FROM scheduled_jobs WHERE job_name = ?')
      .get(jobName) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listJobs(): ScheduledJobState[] {
    const rows = this.db
      .prepare('SELECT * FROM scheduled_jobs ORDER BY job_name ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  setPaused(jobName: string, paused: boolean): ScheduledJobState {
    const state = this.getJobState(jobName);
    if (!state) {
      throw new Error(`Scheduled job "${jobName}" is not registered.`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE scheduled_jobs SET is_paused = ?, last_status = ?, updated_at = ? WHERE job_name = ?'
      )
      .run(paused ? 1 : 0, paused ? 'paused' : 'idle', now, jobName);
    return this.getJobState(jobName)!;
  }

  /**
   * Executes a single scheduled tick safely with overlap protection, spend ceiling checks,
   * and failure alert thresholds.
   */
  async triggerJobNow(
    jobName: string,
    estimatedCostUsd: number,
    handler: () => Promise<JobExecutionResult>
  ): Promise<{ executed: boolean; reason?: string; state: ScheduledJobState }> {
    let state = this.getJobState(jobName);
    if (!state) {
      state = this.registerOrUpdateJob(jobName, 60);
    }

    if (state.isPaused) {
      return { executed: false, reason: 'Job is manually paused', state };
    }

    if (state.isRunning) {
      return { executed: false, reason: 'Overlapping execution prevented (already running)', state };
    }

    // Reset daily spend counter if date rolled over
    const today = new Date().toISOString().slice(0, 10);
    let currentDailySpend = state.spendResetDate === today ? state.dailySpendUsd : 0;

    if (currentDailySpend + estimatedCostUsd > this.config.MAX_DAILY_ESTIMATED_SPEND_USD) {
      const msg = `Daily spend limit reached ($${currentDailySpend.toFixed(
        2
      )} + $${estimatedCostUsd.toFixed(2)} > $${this.config.MAX_DAILY_ESTIMATED_SPEND_USD.toFixed(
        2
      )}). Pausing job "${jobName}".`;
      this.setPaused(jobName, true);
      this.emitAlert(jobName, msg);
      return { executed: false, reason: msg, state: this.getJobState(jobName)! };
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET
          is_running = 1,
          last_status = 'running',
          spend_reset_date = ?,
          daily_spend_usd = ?,
          updated_at = ?
        WHERE job_name = ?`
      )
      .run(today, currentDailySpend, now, jobName);

    try {
      const res = await handler();
      currentDailySpend += res.spendUsd;
      const completedAt = new Date().toISOString();
      const nextRunAt = new Date(
        Date.now() + state.intervalMinutes * 60 * 1000
      ).toISOString();

      this.db
        .prepare(
          `UPDATE scheduled_jobs SET
            is_running = 0,
            consecutive_failures = 0,
            last_run_at = ?,
            next_run_at = ?,
            last_status = 'succeeded',
            last_error = NULL,
            daily_spend_usd = ?,
            updated_at = ?
          WHERE job_name = ?`
        )
        .run(completedAt, nextRunAt, currentDailySpend, completedAt, jobName);

      return { executed: true, state: this.getJobState(jobName)! };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failures = state.consecutiveFailures + 1;
      const failedAt = new Date().toISOString();
      const nextRunAt = new Date(
        Date.now() + state.intervalMinutes * 60 * 1000
      ).toISOString();

      this.db
        .prepare(
          `UPDATE scheduled_jobs SET
            is_running = 0,
            consecutive_failures = ?,
            last_run_at = ?,
            next_run_at = ?,
            last_status = 'failed',
            last_error = ?,
            updated_at = ?
          WHERE job_name = ?`
        )
        .run(failures, failedAt, nextRunAt, errorMsg, failedAt, jobName);

      if (failures >= 3) {
        this.emitAlert(
          jobName,
          `Repeated collection failure alert: Job "${jobName}" has failed ${failures} consecutive times. Latest error: ${errorMsg}`
        );
      }

      return {
        executed: false,
        reason: errorMsg,
        state: this.getJobState(jobName)!,
      };
    }
  }

  startInterval(
    jobName: string,
    intervalMinutes: number,
    estimatedCostUsd: number,
    handler: () => Promise<JobExecutionResult>
  ): void {
    this.stopInterval(jobName);
    this.registerOrUpdateJob(jobName, intervalMinutes);
    const intervalMs = Math.max(10_000, intervalMinutes * 60 * 1000);
    const timer = setInterval(() => {
      void this.triggerJobNow(jobName, estimatedCostUsd, handler);
    }, intervalMs);
    this.timers.set(jobName, timer);
  }

  stopInterval(jobName: string): void {
    const existing = this.timers.get(jobName);
    if (existing) {
      clearInterval(existing);
      this.timers.delete(jobName);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private emitAlert(jobName: string, message: string): void {
    logger.warn({ jobName, alert: message }, 'SCHEDULER ALERT');
    if (this.onAlert) {
      this.onAlert(jobName, message);
    }
  }

  private mapRow(r: Record<string, unknown>): ScheduledJobState {
    return {
      id: String(r.id),
      jobName: String(r.job_name),
      intervalMinutes: Number(r.interval_minutes),
      isPaused: Boolean(r.is_paused),
      isRunning: Boolean(r.is_running),
      consecutiveFailures: Number(r.consecutive_failures),
      lastRunAt: r.last_run_at !== null ? String(r.last_run_at) : null,
      nextRunAt: r.next_run_at !== null ? String(r.next_run_at) : null,
      lastStatus: r.last_status !== null ? String(r.last_status) : null,
      lastError: r.last_error !== null ? String(r.last_error) : null,
      dailySpendUsd: Number(r.daily_spend_usd),
      spendResetDate: String(r.spend_reset_date),
      updatedAt: String(r.updated_at),
    };
  }
}
