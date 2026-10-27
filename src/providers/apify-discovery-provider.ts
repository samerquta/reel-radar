import { ApifyClient } from 'apify-client';
import {
  CompetitorCandidateSignal,
  CompetitorDiscoveryInput,
  CompetitorDiscoveryProvider,
  DiscoveryQueryOptions,
  DiscoveryResult,
  NormalizedCollectedReel,
  ReelDiscoveryProvider,
} from './interfaces.js';
import { normalizeRawReelItem } from './normalizer.js';
import { calculateMedian } from '../domain/scoring.js';
import { defaultIsTransientError, withExponentialBackoff } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

/**
 * Official Apify Actor `apify/instagram-hashtag-scraper` input schema for Reels discovery:
 * - hashtags (string[], required): Hashtags (without #) or keyword phrases
 * - keywordSearch (boolean, optional): True for keyword search mode
 * - resultsType ('reels' | 'posts' | 'stories', optional): Set to 'reels'
 * - maxPostsPerHashtag (integer, optional)
 */
export interface ApifyHashtagScraperInput {
  hashtags: string[];
  keywordSearch?: boolean;
  resultsType: 'reels';
  maxPostsPerHashtag?: number;
}

export interface ApifyHashtagDiscoveryProviderConfig {
  apifyToken: string;
  actorId?: string;
  defaultMaxPostsPerQuery?: number;
  costPerThousandResultsUsd?: number;
  client?: Pick<ApifyClient, 'actor' | 'dataset'>;
}

export class ApifyHashtagDiscoveryProvider
  implements ReelDiscoveryProvider, CompetitorDiscoveryProvider
{
  public readonly name = 'apify/instagram-hashtag-scraper';
  private readonly actorId: string;
  private readonly defaultMaxPostsPerQuery: number;
  private readonly costPerThousandResultsUsd: number;
  private readonly client: Pick<ApifyClient, 'actor' | 'dataset'>;

  constructor(config: ApifyHashtagDiscoveryProviderConfig) {
    if (!config.apifyToken && !config.client) {
      throw new Error(
        'ApifyHashtagDiscoveryProvider requires a valid apifyToken or an injected ApifyClient.'
      );
    }
    this.actorId = config.actorId ?? 'apify/instagram-hashtag-scraper';
    this.defaultMaxPostsPerQuery = config.defaultMaxPostsPerQuery ?? 25;
    this.costPerThousandResultsUsd = config.costPerThousandResultsUsd ?? 2.6;
    this.client = config.client ?? new ApifyClient({ token: config.apifyToken });
  }

  estimateCostUsd(options: DiscoveryQueryOptions): number {
    const queryCount = (options.hashtags?.length ?? 0) + (options.keywords?.length ?? 0);
    const maxPerQuery = options.maxPostsPerQuery ?? this.defaultMaxPostsPerQuery;
    const expectedItems = Math.max(1, queryCount) * maxPerQuery;
    return Number(Math.max(0.01, (expectedItems / 1000) * this.costPerThousandResultsUsd).toFixed(4));
  }

  async discoverReels(options: DiscoveryQueryOptions): Promise<DiscoveryResult> {
    const startedAt = new Date().toISOString();
    const hashtags = (options.hashtags ?? [])
      .map((h) => h.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean);
    const keywords = (options.keywords ?? []).map((k) => k.trim()).filter(Boolean);

    const discoveredReels: NormalizedCollectedReel[] = [];
    const errors: DiscoveryResult['errors'] = [];
    const runIds: string[] = [];

    const maxPostsPerHashtag = options.maxPostsPerQuery ?? this.defaultMaxPostsPerQuery;
    const waitSecs = options.timeoutSecs ?? 180;

    const executeQueryBatch = async (queries: string[], keywordSearch: boolean) => {
      if (queries.length === 0) return;
      const input: ApifyHashtagScraperInput = {
        hashtags: queries,
        keywordSearch,
        resultsType: 'reels',
        maxPostsPerHashtag,
      };

      try {
        const run = await withExponentialBackoff(
          async () => {
            const actorRun = await this.client.actor(this.actorId).call(input, { waitSecs });
            if (!actorRun) {
              throw new Error(`Discovery Actor ${this.actorId} returned null run`);
            }
            if (actorRun.status !== 'SUCCEEDED') {
              throw new Error(
                `Discovery Actor run ${actorRun.id} finished with status ${actorRun.status}`
              );
            }
            return actorRun;
          },
          { maxAttempts: 3, baseDelayMs: 400, signal: options.signal }
        );

        runIds.push(run.id);
        const datasetPage = await withExponentialBackoff(
          async () =>
            this.client.dataset(run.defaultDatasetId).listItems({ clean: true, limit: 1000 }),
          { maxAttempts: 3, baseDelayMs: 250, signal: options.signal }
        );

        const collectedAt = new Date().toISOString();
        for (let i = 0; i < (datasetPage.items ?? []).length; i++) {
          const norm = normalizeRawReelItem(datasetPage.items[i], {
            providerRunId: run.id,
            defaultCollectedAt: collectedAt,
            rawDataReference: `apify:discovery:${run.defaultDatasetId}#${i}`,
          });
          if (norm.reel) {
            discoveredReels.push(norm.reel);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isTransient = defaultIsTransientError(err);
        logger.error({ queries, keywordSearch, error: message }, 'Discovery query batch failed');
        errors.push({
          query: queries.join(', '),
          message,
          isTransient,
        });
      }
    };

    await executeQueryBatch(hashtags, false);
    await executeQueryBatch(keywords, true);

    // Deduplicate discovered Reels by externalId
    const uniqueReelsMap = new Map<string, NormalizedCollectedReel>();
    for (const reel of discoveredReels) {
      if (!uniqueReelsMap.has(reel.externalId)) {
        uniqueReelsMap.set(reel.externalId, reel);
      }
    }

    return {
      providerName: this.name,
      providerRunId: runIds.length > 0 ? runIds.join(',') : `discovery-${Date.now()}`,
      startedAt,
      completedAt: new Date().toISOString(),
      discoveredReels: Array.from(uniqueReelsMap.values()),
      errors,
      estimatedCostUsd: this.estimateCostUsd(options),
    };
  }

  async discoverCandidates(input: CompetitorDiscoveryInput): Promise<{
    providerRunId: string;
    candidates: CompetitorCandidateSignal[];
    discoveredReels: NormalizedCollectedReel[];
    estimatedCostUsd: number;
  }> {
    const discoveryRes = await this.discoverReels({
      hashtags: input.hashtags,
      keywords: input.keywords,
      maxPostsPerQuery: input.maxPostsPerQuery ?? this.defaultMaxPostsPerQuery,
      language: input.language,
    });

    const candidates = rankCompetitorCandidatesFromReels(
      discoveryRes.discoveredReels,
      input
    );

    return {
      providerRunId: discoveryRes.providerRunId,
      candidates,
      discoveredReels: discoveryRes.discoveredReels,
      estimatedCostUsd: discoveryRes.estimatedCostUsd ?? 0,
    };
  }
}

/**
 * Pure deterministic function that groups discovered Reels by creator, deduplicates against seed accounts,
 * computes transparent niche relevance scores (0-100), and ranks candidate accounts.
 */
export function rankCompetitorCandidatesFromReels(
  discoveredReels: NormalizedCollectedReel[],
  input: CompetitorDiscoveryInput
): CompetitorCandidateSignal[] {
  const seedSet = new Set(
    (input.seedAccounts ?? []).map((s) => s.trim().replace(/^@/, '').toLowerCase())
  );
  const queryTerms = Array.from(
    new Set(
      [...input.keywords, ...input.hashtags, input.niche]
        .flatMap((t) => t.toLowerCase().split(/[\s,#]+/))
        .filter((t) => t.length >= 2)
    )
  );

  const byCreator = new Map<string, NormalizedCollectedReel[]>();
  for (const reel of discoveredReels) {
    const username = reel.creatorUsername.toLowerCase();
    if (seedSet.has(username)) continue;
    const list = byCreator.get(username) ?? [];
    list.push(reel);
    byCreator.set(username, list);
  }

  const candidates: CompetitorCandidateSignal[] = [];

  for (const [username, reels] of byCreator.entries()) {
    const matchedTerms = new Set<string>();
    for (const r of reels) {
      const text = `${r.caption ?? ''} ${r.hashtags.join(' ')} ${r.transcript ?? ''}`.toLowerCase();
      for (const term of queryTerms) {
        if (text.includes(term)) {
          matchedTerms.add(term);
        }
      }
    }

    const validViews = reels
      .map((r) => r.views ?? r.plays)
      .filter((v): v is number => typeof v === 'number' && v > 0);

    const maxViewsObserved = validViews.length > 0 ? Math.max(...validViews) : null;
    const medianViewsObserved = calculateMedian(validViews);

    // Transparent Niche Relevance Score (0-100):
    // - Up to 50 pts for query term/hashtag match coverage
    // - Up to 30 pts for multiple discovered Reels in niche
    // - Up to 20 pts for strong observed Reel views (>25k)
    const termCoverage =
      queryTerms.length > 0 ? Math.min(1, matchedTerms.size / Math.min(4, queryTerms.length)) : 0.5;
    const multiReelSignal = Math.min(1, reels.length / 3);
    const performanceSignal =
      maxViewsObserved !== null ? Math.min(1, Math.log10(maxViewsObserved + 1) / 5) : 0.2;

    const nicheRelevanceScore = Number(
      (termCoverage * 50 + multiReelSignal * 30 + performanceSignal * 20).toFixed(1)
    );

    const first = reels[0]!;
    const matchedList = Array.from(matchedTerms).slice(0, 5).join(', ') || input.niche;

    candidates.push({
      username,
      profileUrl: first.creatorProfileUrl ?? `https://www.instagram.com/${username}/`,
      displayName: first.creatorDisplayName ?? null,
      followerCount: first.creatorFollowerCount ?? null,
      niche: input.niche,
      language: first.transcriptLanguage ?? input.language ?? 'en',
      discoverySource: 'hashtag_keyword_discovery',
      discoveryReason: `Discovered ${reels.length} Reel(s) matching [${matchedList}] with max views ${
        maxViewsObserved !== null ? maxViewsObserved.toLocaleString() : 'N/A'
      } (relevance: ${nicheRelevanceScore}/100).`,
      nicheRelevanceScore,
      discoveredReelsCount: reels.length,
      maxViewsObserved,
      medianViewsObserved,
      supportingReelUrls: reels.map((r) => r.canonicalUrl).slice(0, 5),
    });
  }

  candidates.sort((a, b) => {
    if (b.nicheRelevanceScore !== a.nicheRelevanceScore) {
      return b.nicheRelevanceScore - a.nicheRelevanceScore;
    }
    return (b.maxViewsObserved ?? 0) - (a.maxViewsObserved ?? 0);
  });

  const maxNew = input.maxNewAccounts ?? 10;
  return candidates.slice(0, maxNew);
}
