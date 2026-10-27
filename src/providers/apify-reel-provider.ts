import { ApifyClient } from 'apify-client';
import {
  CollectionBatchResult,
  CollectionOptions,
  NormalizedCollectedReel,
  ReelCollectionProvider,
} from './interfaces.js';
import { normalizeRawReelItem } from './normalizer.js';
import {
  defaultIsTransientError,
  runWithConcurrency,
  withExponentialBackoff,
} from '../utils/retry.js';
import { logger } from '../utils/logger.js';

/**
 * Official Apify Actor `apify/instagram-reel-scraper` input payload based on documented schema:
 * - username (string[], required): Instagram usernames, profile URLs, or direct Reel URLs
 * - resultsLimit (integer, optional): Max Reels per profile
 * - onlyPostsNewerThan (string, optional): YYYY-MM-DD, ISO timestamp, or relative string
 * - skipPinnedPosts (boolean, optional)
 */
export interface ApifyReelScraperActorInput {
  username: string[];
  resultsLimit?: number;
  onlyPostsNewerThan?: string;
  skipPinnedPosts?: boolean;
}

export interface ApifyInstagramReelProviderConfig {
  apifyToken: string;
  actorId?: string;
  maxConcurrentJobs?: number;
  defaultResultsLimit?: number;
  datasetPageSize?: number;
  costPerThousandReelsUsd?: number;
  client?: Pick<ApifyClient, 'actor' | 'dataset'>;
}

export class ApifyInstagramReelProvider implements ReelCollectionProvider {
  public readonly name = 'apify/instagram-reel-scraper';
  private readonly actorId: string;
  private readonly maxConcurrentJobs: number;
  private readonly defaultResultsLimit: number;
  private readonly datasetPageSize: number;
  private readonly costPerThousandReelsUsd: number;
  private readonly client: Pick<ApifyClient, 'actor' | 'dataset'>;

  constructor(config: ApifyInstagramReelProviderConfig) {
    if (!config.apifyToken && !config.client) {
      throw new Error(
        'ApifyInstagramReelProvider requires a valid apifyToken or an injected ApifyClient.'
      );
    }
    this.actorId = config.actorId ?? 'apify/instagram-reel-scraper';
    this.maxConcurrentJobs = config.maxConcurrentJobs ?? 2;
    this.defaultResultsLimit = config.defaultResultsLimit ?? 20;
    this.datasetPageSize = config.datasetPageSize ?? 100;
    this.costPerThousandReelsUsd = config.costPerThousandReelsUsd ?? 2.6;
    this.client = config.client ?? new ApifyClient({ token: config.apifyToken });
  }

  estimateCostUsd(options: CollectionOptions): number {
    const profileCount = options.usernames?.length ?? 0;
    const directUrlCount = options.directReelUrls?.length ?? 0;
    const limitPerProfile = options.resultsLimitPerProfile ?? this.defaultResultsLimit;
    const totalExpectedItems = profileCount * limitPerProfile + directUrlCount;
    const estimated = (totalExpectedItems / 1000) * this.costPerThousandReelsUsd;
    return Number(Math.max(0.01, estimated).toFixed(4));
  }

  async collectReels(options: CollectionOptions): Promise<CollectionBatchResult> {
    const startedAt = new Date().toISOString();
    const usernames = (options.usernames ?? []).map((u) => u.trim()).filter(Boolean);
    const directUrls = (options.directReelUrls ?? []).map((u) => u.trim()).filter(Boolean);
    const targets = [...usernames, ...directUrls];

    if (targets.length === 0) {
      return {
        providerName: this.name,
        providerRunId: 'noop-empty-targets',
        startedAt,
        completedAt: new Date().toISOString(),
        reels: [],
        missingFieldsSummary: {},
        errors: [],
        estimatedCostUsd: 0,
      };
    }

    const reels: NormalizedCollectedReel[] = [];
    const missingFieldsSummary: Record<string, number> = {};
    const errors: CollectionBatchResult['errors'] = [];
    const runIds: string[] = [];

    // Isolate errors per account/target while respecting concurrency limits
    await runWithConcurrency(
      targets,
      this.maxConcurrentJobs,
      async (target) => {
        try {
          const singleRes = await this.collectSingleTarget(target, options);
          runIds.push(singleRes.runId);
          reels.push(...singleRes.reels);
          for (const field of singleRes.missingFields) {
            missingFieldsSummary[field] = (missingFieldsSummary[field] ?? 0) + 1;
          }
          if (singleRes.validationErrors.length > 0) {
            for (const vErr of singleRes.validationErrors) {
              errors.push({
                target,
                message: vErr,
                isTransient: false,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isTransient = defaultIsTransientError(err);
          logger.error(
            { target, actorId: this.actorId, error: message, isTransient },
            'Apify Reel collection failed for target'
          );
          errors.push({ target, message, isTransient });
        }
      },
      options.signal
    );

    const completedAt = new Date().toISOString();
    return {
      providerName: this.name,
      providerRunId: runIds.length > 0 ? runIds.join(',') : `failed-${Date.now()}`,
      startedAt,
      completedAt,
      reels,
      missingFieldsSummary,
      errors,
      estimatedCostUsd: this.estimateCostUsd(options),
    };
  }

  private async collectSingleTarget(
    target: string,
    options: CollectionOptions
  ): Promise<{
    runId: string;
    reels: NormalizedCollectedReel[];
    missingFields: string[];
    validationErrors: string[];
  }> {
    const actorInput: ApifyReelScraperActorInput = {
      username: [target],
      resultsLimit: options.resultsLimitPerProfile ?? this.defaultResultsLimit,
    };

    if (options.onlyPostsNewerThan) {
      actorInput.onlyPostsNewerThan = options.onlyPostsNewerThan;
    }
    if (options.skipPinnedPosts !== undefined) {
      actorInput.skipPinnedPosts = options.skipPinnedPosts;
    }

    const waitSecs = options.timeoutSecs ?? 180;

    const run = await withExponentialBackoff(
      async () => {
        const actorClient = this.client.actor(this.actorId);
        const actorRun = await actorClient.call(actorInput, { waitSecs });
        if (!actorRun) {
          throw new Error(`Actor ${this.actorId} returned null run object`);
        }
        if (actorRun.status === 'TIMED-OUT' || actorRun.status === 'RUNNING') {
          throw new Error(
            `Actor run ${actorRun.id} timed out after ${waitSecs}s (status: ${actorRun.status})`
          );
        }
        if (actorRun.status !== 'SUCCEEDED') {
          throw new Error(
            `Actor run ${actorRun.id} finished with non-success status: ${actorRun.status}`
          );
        }
        return actorRun;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 400,
        signal: options.signal,
      }
    );

    const rawItems = await this.fetchPaginatedDatasetItems(
      run.defaultDatasetId,
      options.signal
    );

    const collectedAt = new Date().toISOString();
    const fallbackUsername = target.startsWith('http') ? undefined : target;

    const normalizedReels: NormalizedCollectedReel[] = [];
    const missingFields: string[] = [];
    const validationErrors: string[] = [];

    for (let idx = 0; idx < rawItems.length; idx++) {
      const raw = rawItems[idx];
      const norm = normalizeRawReelItem(raw, {
        providerRunId: run.id,
        defaultCollectedAt: collectedAt,
        fallbackUsername,
        rawDataReference: `apify:dataset:${run.defaultDatasetId}#${idx}`,
      });

      if (norm.validationError || !norm.reel) {
        validationErrors.push(norm.validationError ?? 'Unknown item normalization error');
        continue;
      }

      normalizedReels.push(norm.reel);
      missingFields.push(...norm.missingFields);
    }

    return {
      runId: run.id,
      reels: normalizedReels,
      missingFields,
      validationErrors,
    };
  }

  private async fetchPaginatedDatasetItems(
    datasetId: string,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const allItems: unknown[] = [];
    let offset = 0;
    const limit = this.datasetPageSize;

    while (true) {
      if (signal?.aborted) {
        throw new Error('Dataset pagination cancelled via AbortSignal');
      }

      const page = await withExponentialBackoff(
        async () =>
          this.client.dataset(datasetId).listItems({
            offset,
            limit,
            clean: true,
          }),
        { maxAttempts: 3, baseDelayMs: 250, signal }
      );

      const items = page.items ?? [];
      allItems.push(...items);

      if (items.length < limit || allItems.length >= (page.total ?? Infinity)) {
        break;
      }
      offset += items.length;
    }

    return allItems;
  }
}
