import { AppConfig } from '../config/env.js';
import { ReelRadarRepository } from '../db/repository.js';
import { CompetitorAccount } from '../domain/entities.js';
import {
  CompetitorCandidateSignal,
  CompetitorDiscoveryInput,
  CompetitorDiscoveryProvider,
} from '../providers/interfaces.js';
import { logger } from '../utils/logger.js';

export interface DiscoveryWorkflowResult {
  runId: string;
  niche: string;
  queriesExecuted: string[];
  discoveredReelsCount: number;
  candidatesEvaluated: number;
  candidatesSaved: CompetitorAccount[];
  autoApproved: boolean;
  estimatedCostUsd: number;
}

export class CompetitorDiscoveryService {
  constructor(
    private readonly repo: ReelRadarRepository,
    private readonly config: AppConfig
  ) {}

  /**
   * Controlled competitor discovery loop (Section 8):
   * 1. Generates candidate discovery queries from user inputs and validated analysis results.
   * 2. Enforces spend and volume guardrails (maxNewAccountsPerRun, maxTotalAccountsPerNiche, maxDailySpend).
   * 3. Saves candidates with status='candidate' (requires user approval unless AUTO_APPROVE_CANDIDATES=true).
   */
  async runControlledDiscovery(
    provider: CompetitorDiscoveryProvider,
    input: {
      niche: string;
      keywords?: string[];
      hashtags?: string[];
      language?: string;
      maxNewAccounts?: number;
      maxPostsPerQuery?: number;
      autoApprove?: boolean;
    }
  ): Promise<DiscoveryWorkflowResult> {
    const existingAccounts = this.repo.listAccounts();
    const nicheAccounts = existingAccounts.filter(
      (a) => (a.niche ?? '').toLowerCase() === input.niche.toLowerCase()
    );

    if (nicheAccounts.length >= this.config.MAX_TOTAL_ACCOUNTS_PER_NICHE) {
      throw new Error(
        `Niche account limit reached (${nicheAccounts.length}/${this.config.MAX_TOTAL_ACCOUNTS_PER_NICHE}) for niche "${input.niche}". Increase MAX_TOTAL_ACCOUNTS_PER_NICHE or exclude inactive accounts.`
      );
    }

    // Enrich discovery queries from top analyzed Reel hashtags if available
    const seedAccounts = existingAccounts.map((a) => a.username);
    const derivedHashtags = new Set<string>(
      (input.hashtags ?? []).map((h) => h.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
    );
    const keywords = (input.keywords ?? []).map((k) => k.trim()).filter(Boolean);

    if (derivedHashtags.size === 0 && keywords.length === 0) {
      // Fall back to niche terms
      keywords.push(input.niche);
    }

    const maxNewAccounts = Math.min(
      input.maxNewAccounts ?? this.config.MAX_NEW_ACCOUNTS_PER_RUN,
      Math.max(0, this.config.MAX_TOTAL_ACCOUNTS_PER_NICHE - nicheAccounts.length),
      this.config.MAX_NEW_ACCOUNTS_PER_RUN
    );

    const run = this.repo.createResearchRun({
      provider: provider.name,
      mode: 'viral_discovery',
    });

    const discoveryInput: CompetitorDiscoveryInput = {
      niche: input.niche,
      keywords,
      hashtags: Array.from(derivedHashtags),
      language: input.language ?? 'en',
      seedAccounts,
      maxNewAccounts,
      maxPostsPerQuery: input.maxPostsPerQuery ?? 25,
    };

    try {
      const res = await provider.discoverCandidates(discoveryInput);

      if (res.estimatedCostUsd > this.config.MAX_DAILY_ESTIMATED_SPEND_USD) {
        throw new Error(
          `Estimated discovery spend ($${res.estimatedCostUsd.toFixed(
            2
          )}) exceeds MAX_DAILY_ESTIMATED_SPEND_USD ($${this.config.MAX_DAILY_ESTIMATED_SPEND_USD.toFixed(2)}).`
        );
      }

      const autoApprove = input.autoApprove ?? this.config.AUTO_APPROVE_CANDIDATES;
      const targetStatus = autoApprove ? 'active' : 'candidate';

      const savedAccounts: CompetitorAccount[] = [];
      for (const candidate of res.candidates.slice(0, maxNewAccounts)) {
        const saved = this.saveCandidateSignal(candidate, targetStatus);
        savedAccounts.push(saved);
      }

      // Also ingest the discovered Reels so their metrics and URLs are preserved in SQLite
      let insertedReels = 0;
      let updatedReels = 0;
      const candidateUsernames = new Set(savedAccounts.map((a) => a.username));

      for (const reel of res.discoveredReels) {
        const defaultStatus = candidateUsernames.has(reel.creatorUsername)
          ? targetStatus
          : 'candidate';
        const ingested = this.repo.ingestNormalizedReel(reel, {
          defaultAccountStatus: defaultStatus,
          discoverySource: 'viral_discovery',
          niche: input.niche,
        });
        if (ingested.insertedReel) insertedReels++;
        else updatedReels++;
      }

      this.repo.completeResearchRun(run.id, {
        status: 'completed',
        recordsDiscovered: res.discoveredReels.length,
        recordsInserted: insertedReels,
        recordsUpdated: updatedReels,
        errors: [],
      });

      logger.info(
        {
          runId: run.id,
          niche: input.niche,
          candidatesSaved: savedAccounts.length,
          status: targetStatus,
        },
        'Completed controlled competitor discovery run'
      );

      return {
        runId: run.id,
        niche: input.niche,
        queriesExecuted: [...keywords, ...Array.from(derivedHashtags)],
        discoveredReelsCount: res.discoveredReels.length,
        candidatesEvaluated: res.candidates.length,
        candidatesSaved: savedAccounts,
        autoApproved: autoApprove,
        estimatedCostUsd: res.estimatedCostUsd,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.repo.completeResearchRun(run.id, {
        status: 'failed',
        recordsDiscovered: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        errors: [
          {
            stage: 'competitor_discovery',
            message: msg,
            timestamp: new Date().toISOString(),
          },
        ],
      });
      throw err;
    }
  }

  private saveCandidateSignal(
    candidate: CompetitorCandidateSignal,
    defaultStatus: 'candidate' | 'active'
  ): CompetitorAccount {
    const existing = this.repo.getAccountByUsername(candidate.username);
    // Do not downgrade an already 'active' or 'excluded' account back to 'candidate'
    const resolvedStatus = existing ? existing.status : defaultStatus;
    return this.repo.upsertAccount({
      username: candidate.username,
      profileUrl: candidate.profileUrl,
      displayName: candidate.displayName,
      followerCount: candidate.followerCount,
      niche: candidate.niche,
      language: candidate.language,
      discoverySource: candidate.discoverySource,
      discoveryReason: candidate.discoveryReason,
      status: resolvedStatus,
    });
  }
}
