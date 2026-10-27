import { AppConfig } from '../config/env.js';
import { ReelRadarRepository, computeContentFingerprint } from '../db/repository.js';
import {
  ResearchRun,
  ResearchRunError,
  ResearchRunMode,
  ResearchRunStatus,
  ViralScore,
} from '../domain/entities.js';
import { ComparableCreatorReel, scoreReel } from '../domain/scoring.js';
import {
  CollectionOptions,
  ContentAnalysisProvider,
  NormalizedCollectedReel,
  ReelCollectionProvider,
  TranscriptProvider,
} from '../providers/interfaces.js';
import { logger } from '../utils/logger.js';

export interface CollectionPipelineOptions {
  usernames?: string[];
  activeAccountsOnly?: boolean;
  limitPerProfile?: number;
  lookbackDays?: number;
  forceRefresh?: boolean;
  dryRun?: boolean;
  mode?: ResearchRunMode;
  autoScore?: boolean;
  autoAnalyzeTopN?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface CollectionPipelineSummary {
  run: ResearchRun | null;
  dryRun: boolean;
  targetUsernames: string[];
  skippedCachedUsernames: string[];
  estimatedCostUsd: number;
  recordsDiscovered: number;
  recordsInserted: number;
  recordsUpdated: number;
  missingFieldsSummary: Record<string, number>;
  scoredCount: number;
  analyzedCount: number;
  errors: ResearchRunError[];
}

export class CollectionWorkflowService {
  constructor(
    private readonly repo: ReelRadarRepository,
    private readonly config: AppConfig,
    private readonly analysisProvider?: ContentAnalysisProvider,
    private readonly transcriptProvider?: TranscriptProvider
  ) {}

  async executeCollection(
    provider: ReelCollectionProvider,
    options: CollectionPipelineOptions = {}
  ): Promise<CollectionPipelineSummary> {
    const progress = options.onProgress ?? ((msg: string) => logger.info(msg));
    const mode: ResearchRunMode = options.mode ?? 'competitor_monitoring';
    const limitPerProfile = options.limitPerProfile ?? this.config.DEFAULT_RESULTS_PER_PROFILE;
    const lookbackDays = options.lookbackDays ?? this.config.DEFAULT_LOOKBACK_DAYS;

    // 1. Load target accounts
    let candidateUsernames: string[] = [];
    if (options.usernames && options.usernames.length > 0) {
      candidateUsernames = options.usernames.map((u) =>
        u.trim().replace(/^@/, '').toLowerCase()
      );
      for (const username of candidateUsernames) {
        this.repo.upsertAccount({
          username,
          discoverySource: 'cli_manual',
          status: 'active',
        });
      }
    } else if (options.activeAccountsOnly) {
      const activeAccounts = this.repo.listAccounts('active');
      candidateUsernames = activeAccounts.map((a) => a.username);
    }

    // Check cache TTL so we do not repeat successful jobs unnecessarily
    const targetUsernames: string[] = [];
    const skippedCachedUsernames: string[] = [];
    const cacheTtlMs = this.config.CACHE_TTL_MINUTES * 60 * 1000;
    const nowMs = Date.now();

    for (const username of candidateUsernames) {
      const acc = this.repo.getAccountByUsername(username);
      if (
        !options.forceRefresh &&
        cacheTtlMs > 0 &&
        acc?.lastScannedAt &&
        nowMs - new Date(acc.lastScannedAt).getTime() < cacheTtlMs
      ) {
        skippedCachedUsernames.push(username);
      } else {
        targetUsernames.push(username);
      }
    }

    // Note: Keep onlyPostsNewerThan optional unless lookbackDays < 3650 so clock skew or older active posts are not dropped unintentionally
    const lookbackDate =
      options.lookbackDays !== undefined
        ? new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : undefined;

    const providerOptions: CollectionOptions = {
      usernames: targetUsernames.length > 0 ? targetUsernames : undefined,
      resultsLimitPerProfile: limitPerProfile,
      onlyPostsNewerThan: lookbackDate,
      signal: options.signal,
    };

    const estimatedCostUsd = provider.estimateCostUsd(providerOptions);

    if (options.dryRun) {
      progress(
        `[DRY-RUN] Provider=${provider.name} | Targets=${targetUsernames.length} (Skipped cached=${skippedCachedUsernames.length}) | Est. Cost=$${estimatedCostUsd.toFixed(4)}`
      );
      return {
        run: null,
        dryRun: true,
        targetUsernames,
        skippedCachedUsernames,
        estimatedCostUsd,
        recordsDiscovered: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        missingFieldsSummary: {},
        scoredCount: 0,
        analyzedCount: 0,
        errors: [],
      };
    }

    if (
      mode === 'competitor_monitoring' &&
      targetUsernames.length === 0 &&
      provider.name !== 'manual-import'
    ) {
      progress(
        `No eligible accounts to scan (Skipped cached: ${skippedCachedUsernames.length}). Use --force to bypass cache.`
      );
      return {
        run: null,
        dryRun: false,
        targetUsernames: [],
        skippedCachedUsernames,
        estimatedCostUsd: 0,
        recordsDiscovered: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        missingFieldsSummary: {},
        scoredCount: 0,
        analyzedCount: 0,
        errors: [],
      };
    }

    // 2. Create research run
    const run = this.repo.createResearchRun({
      provider: provider.name,
      mode,
    });

    progress(
      `Started research run ${run.id} (${provider.name}, mode=${mode}, estCost=$${estimatedCostUsd.toFixed(4)})`
    );

    // 3-5. Fetch, validate and normalize via provider
    const batch = await provider.collectReels(providerOptions);

    const runErrors: ResearchRunError[] = batch.errors.map((e) => ({
      stage: 'provider_collection',
      target: e.target,
      message: e.message,
      timestamp: new Date().toISOString(),
      isTransient: e.isTransient,
    }));

    // 6-8. Deduplicate and upsert accounts, Reels, and historical metric snapshots
    let recordsInserted = 0;
    let recordsUpdated = 0;

    for (const item of batch.reels) {
      try {
        const res = this.repo.ingestNormalizedReel(item, {
          defaultAccountStatus: 'active',
          discoverySource: mode,
        });
        if (res.insertedReel) {
          recordsInserted++;
        } else {
          recordsUpdated++;
        }
      } catch (err) {
        runErrors.push({
          stage: 'persistence_upsert',
          target: item.externalId,
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 9. Record missing fields summary in logs/errors if substantial
    for (const [field, count] of Object.entries(batch.missingFieldsSummary)) {
      if (count > 0) {
        logger.debug({ runId: run.id, field, count }, 'Missing optional field count in batch');
      }
    }

    // 10. Calculate viral scores across all stored Reels
    let scoredCount = 0;
    if (options.autoScore !== false) {
      const scores = this.recalculateAllViralScores();
      scoredCount = scores.length;
    }

    // 11. Queue eligible videos for AI analysis if requested
    let analyzedCount = 0;
    if (options.autoAnalyzeTopN && options.autoAnalyzeTopN > 0 && this.analysisProvider) {
      analyzedCount = await this.analyzeTopEligibleReels(options.autoAnalyzeTopN);
    }

    // 13. Mark research run complete or partially failed
    let finalStatus: ResearchRunStatus = 'completed';
    if (runErrors.length > 0 && batch.reels.length === 0) {
      finalStatus = 'failed';
    } else if (runErrors.length > 0) {
      finalStatus = 'partially_failed';
    }

    const completedRun = this.repo.completeResearchRun(run.id, {
      status: finalStatus,
      recordsDiscovered: batch.reels.length,
      recordsInserted,
      recordsUpdated,
      errors: runErrors,
    });

    progress(
      `Completed research run ${completedRun.id}: status=${completedRun.status}, discovered=${batch.reels.length}, inserted=${recordsInserted}, updated=${recordsUpdated}, scored=${scoredCount}`
    );

    return {
      run: completedRun,
      dryRun: false,
      targetUsernames,
      skippedCachedUsernames,
      estimatedCostUsd,
      recordsDiscovered: batch.reels.length,
      recordsInserted,
      recordsUpdated,
      missingFieldsSummary: batch.missingFieldsSummary,
      scoredCount,
      analyzedCount,
      errors: runErrors,
    };
  }

  /**
   * Deterministic Viral Scoring Engine orchestration across all Reels in SQLite.
   * Computes cross-creator hashtag/topic confirmation and creator-relative baselines.
   */
  recalculateAllViralScores(referenceNow: Date = new Date()): ViralScore[] {
    const allReels = this.repo.listAllReels();
    if (allReels.length === 0) return [];

    // Build creator comparable Reel lookup and cross-creator topic frequency map
    const creatorReelsMap = new Map<string, ComparableCreatorReel[]>();
    const hashtagCreatorSets = new Map<string, Set<string>>();

    const snapshotsByReel = new Map<string, ReturnType<ReelRadarRepository['listSnapshotsForReel']>>();

    for (const reel of allReels) {
      const snaps = this.repo.listSnapshotsForReel(reel.id);
      snapshotsByReel.set(reel.id, snaps);
      const latest = snaps.length > 0 ? snaps[snaps.length - 1]! : null;

      const list = creatorReelsMap.get(reel.accountId) ?? [];
      list.push({
        reelId: reel.id,
        views: latest?.views ?? null,
        plays: latest?.plays ?? null,
        publishedAt: reel.publishedAt,
        durationSeconds: reel.durationSeconds,
      });
      creatorReelsMap.set(reel.accountId, list);

      for (const tag of reel.hashtags) {
        const set = hashtagCreatorSets.get(tag) ?? new Set<string>();
        set.add(reel.accountId);
        hashtagCreatorSets.set(tag, set);
      }
    }

    const savedScores: ViralScore[] = [];

    for (const reel of allReels) {
      const snaps = snapshotsByReel.get(reel.id) ?? [];
      const comparable = creatorReelsMap.get(reel.accountId) ?? [];

      let maxCrossCreators = 1;
      for (const tag of reel.hashtags) {
        const count = hashtagCreatorSets.get(tag)?.size ?? 1;
        if (count > maxCrossCreators) {
          maxCrossCreators = count;
        }
      }

      const calculated = scoreReel({
        reel,
        snapshots: snaps,
        creatorComparableReels: comparable,
        crossCreatorTopicCount: maxCrossCreators,
        referenceNow,
        config: {
          minVideosForBaseline: this.config.MIN_VIDEOS_FOR_BASELINE,
          baselineFloorViews: this.config.BASELINE_FLOOR_VIEWS,
          recencyHalfLifeDays: this.config.RECENCY_HALF_LIFE_DAYS,
        },
      });

      const saved = this.repo.saveViralScore(calculated);
      savedScores.push(saved);
    }

    return savedScores.sort((a, b) => b.overallScore - a.overallScore);
  }

  /**
   * Analyzes top N eligible Reels using the configured ContentAnalysisProvider (and optional TranscriptProvider).
   * Caches analysis by Reel content fingerprint, model, and promptVersion.
   */
  async analyzeTopEligibleReels(topN: number = 20): Promise<number> {
    if (!this.analysisProvider) {
      throw new Error('No ContentAnalysisProvider configured on CollectionWorkflowService.');
    }

    let scores = this.repo.listViralScoresOrdered();
    if (scores.length === 0) {
      scores = this.recalculateAllViralScores();
    }

    const eligibleScores = scores
      .filter((s) => s.explanation.classification !== 'Insufficient evidence')
      .slice(0, topN);

    let analyzedCount = 0;

    for (const score of eligibleScores) {
      const reel = this.repo.getReelById(score.reelId);
      if (!reel) continue;

      const account = this.repo.getAccountById(reel.accountId);
      const latestSnap = this.repo.getLatestSnapshotForReel(reel.id);

      // Optional transcription step if transcript is missing and provider is enabled
      let currentTranscript = reel.transcript;
      if (!currentTranscript && this.transcriptProvider && this.transcriptProvider.name !== 'none') {
        const trRes = await this.transcriptProvider.transcribe({
          reelId: reel.id,
          canonicalUrl: reel.canonicalUrl,
          mediaUrl: reel.mediaUrl,
          durationSeconds: reel.durationSeconds,
          existingTranscript: reel.transcript,
        });
        if (trRes.transcript) {
          currentTranscript = trRes.transcript;
          this.repo.updateReelTranscript(reel.id, trRes.transcript, trRes.language);
        }
      }

      const fingerprint = computeContentFingerprint({
        caption: reel.caption,
        transcript: currentTranscript,
        hashtags: reel.hashtags,
      });

      const cached = this.repo.getCachedAnalysis(
        reel.id,
        this.analysisProvider.model,
        this.analysisProvider.promptVersion,
        fingerprint
      );

      if (cached) {
        analyzedCount++;
        continue;
      }

      const output = await this.analysisProvider.analyzeReel({
        reelId: reel.id,
        canonicalUrl: reel.canonicalUrl,
        creatorUsername: account?.username ?? 'unknown',
        caption: reel.caption,
        hashtags: reel.hashtags,
        transcript: currentTranscript,
        durationSeconds: reel.durationSeconds,
        publishedAt: reel.publishedAt,
        views: score.explanation.effectiveViews,
        likes: latestSnap?.likes ?? null,
        comments: latestSnap?.comments ?? null,
        shares: latestSnap?.shares ?? null,
        baselineViews: score.baselineViews,
        outlierRatio: score.outlierRatio,
      });

      this.repo.saveReelAnalysis({
        reelId: reel.id,
        model: this.analysisProvider.model,
        promptVersion: this.analysisProvider.promptVersion,
        contentFingerprint: fingerprint,
        output,
      });

      analyzedCount++;
    }

    return analyzedCount;
  }
}
