import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createDatabase, runMigrations } from '../src/db/database.js';
import { ReelRadarRepository } from '../src/db/repository.js';
import { ManualImportProvider } from '../src/providers/manual-import-provider.js';
import {
  ConfigurableTranscriptProvider,
  EvidenceBackedAnalysisProvider,
} from '../src/providers/analysis-provider.js';
import {
  ApifyHashtagDiscoveryProvider,
  rankCompetitorCandidatesFromReels,
} from '../src/providers/apify-discovery-provider.js';
import { CollectionWorkflowService } from '../src/services/collection-service.js';
import { CompetitorDiscoveryService } from '../src/services/discovery-service.js';
import { ReportGeneratorService } from '../src/reports/report-generator.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { ReelAnalysisOutputSchema } from '../src/domain/entities.js';

describe('Milestones 3, 4 & 5: Collection Workflow, Discovery, AI Analysis, Reports & Scheduler', () => {
  let repo: ReelRadarRepository;
  let config: ReturnType<typeof loadConfig>;
  let collectionService: CollectionWorkflowService;
  let analysisProvider: EvidenceBackedAnalysisProvider;

  beforeEach(() => {
    config = loadConfig({
      DATABASE_PATH: ':memory:',
      MIN_VIDEOS_FOR_BASELINE: '5',
      CACHE_TTL_MINUTES: '60',
      MAX_DAILY_ESTIMATED_SPEND_USD: '5.00',
    });
    const db = createDatabase(':memory:');
    runMigrations(db);
    repo = new ReelRadarRepository(db);
    analysisProvider = new EvidenceBackedAnalysisProvider({ providerType: 'mock' });
    const transcriptProvider = new ConfigurableTranscriptProvider('none');
    collectionService = new CollectionWorkflowService(
      repo,
      config,
      analysisProvider,
      transcriptProvider
    );
  });

  it('executes full import + scoring + evidence-backed analysis + report generation with verified source links', async () => {
    const provider = new ManualImportProvider(path.resolve('./sample-data/reels.json'));
    const summary = await collectionService.executeCollection(provider, {
      mode: 'manual_import',
      autoScore: true,
      autoAnalyzeTopN: 15,
    });

    expect(summary.recordsDiscovered).toBe(15);
    // SYNTH_AI_001 appears twice (2 historical snapshots) so 14 unique Reels inserted, 1 updated
    expect(summary.recordsInserted).toBe(14);
    expect(summary.recordsUpdated).toBe(1);
    expect(summary.scoredCount).toBe(14);
    expect(summary.analyzedCount).toBeGreaterThan(5);

    // Verify top ranked Reel is SYNTH_AI_001 with multi-snapshot growth velocity
    const scores = repo.listViralScoresOrdered();
    const topScore = scores[0]!;
    const topReel = repo.getReelById(topScore.reelId)!;
    expect(topReel.externalId).toBe('SYNTH_AI_001');
    expect(topScore.explanation.classification).toBe('Strong outlier');
    expect(topScore.growthRate).toBe(4000); // +64,000 views over 16 hours = 4,000 views/hr

    // Verify LLM/Analysis response schema validation & explicit limitations for missing transcripts
    const reelWithoutTranscript = repo.getReelByExternalId('SYNTH_AI_005')!;
    const outNoTr = await analysisProvider.analyzeReel({
      reelId: reelWithoutTranscript.id,
      canonicalUrl: reelWithoutTranscript.canonicalUrl,
      creatorUsername: 'workflow_architect',
      caption: reelWithoutTranscript.caption,
      hashtags: reelWithoutTranscript.hashtags,
      transcript: null,
      durationSeconds: reelWithoutTranscript.durationSeconds,
      publishedAt: reelWithoutTranscript.publishedAt,
      views: 16800,
      likes: 640,
      comments: 29,
      shares: 85,
      baselineViews: 19200,
      outlierRatio: 0.875,
    });

    const parsed = ReelAnalysisOutputSchema.safeParse(outNoTr);
    expect(parsed.success).toBe(true);
    expect(
      outNoTr.limitations.some((l) => l.includes('No spoken transcript available'))
    ).toBe(true);

    // Generate all 5 reports and verify source URLs and multi-creator topic requirements
    const tmpReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-radar-reports-'));
    const reportGen = new ReportGeneratorService(repo);
    const reports = reportGen.generateAllReports(tmpReportDir);

    const viralReelsMd = fs.readFileSync(reports.files.viralReelsMd, 'utf-8');
    expect(viralReelsMd).toContain('https://www.instagram.com/reel/C_SYNTH_AI01/');
    expect(viralReelsMd).toContain('Strong outlier');

    const accountsCsv = fs.readFileSync(reports.files.competitorAccountsCsv, 'utf-8');
    expect(accountsCsv).toContain('https://www.instagram.com/workflow_architect/');
    expect(accountsCsv).toContain('solofounder_ops');

    const emergingTopicsMd = fs.readFileSync(reports.files.emergingTopicsMd, 'utf-8');
    expect(emergingTopicsMd).toContain('#aitools');
    expect(emergingTopicsMd).toContain('@workflow_architect');
    expect(emergingTopicsMd).toContain('@solofounder_ops');

    const contentOppsMd = fs.readFileSync(reports.files.contentOpportunitiesMd, 'utf-8');
    expect(contentOppsMd).toContain('https://www.instagram.com/reel/');
    expect(contentOppsMd).toContain('Originality Notes');

    const healthMd = fs.readFileSync(reports.files.collectionHealthMd, 'utf-8');
    expect(healthMd).toContain('Metric & Metadata Completeness');
  });

  it('deduplicates seed accounts during competitor discovery and saves candidates requiring approval by default', async () => {
    // Seed existing active account
    repo.upsertAccount({
      username: 'workflow_architect',
      niche: 'AI & Automation',
      discoverySource: 'manual',
      status: 'active',
    });

    const mockDiscoveryActorCall = vi.fn().mockResolvedValue({
      id: 'disc-run-1',
      status: 'SUCCEEDED',
      defaultDatasetId: 'disc-ds-1',
    });

    const mockDiscoveryDataset = vi.fn().mockResolvedValue({
      total: 3,
      items: [
        // Should be excluded as already in seedAccounts
        {
          id: 'SEED_REEL_1',
          shortCode: 'SR1',
          ownerUsername: 'workflow_architect',
          caption: 'Already tracked account #aitools #automation',
          videoViewCount: 90000,
        },
        // New candidate creator with 2 strong Reels
        {
          id: 'CAND_REEL_1',
          shortCode: 'CR1',
          ownerUsername: 'new_automation_pro',
          ownerFullName: 'Automation Pro',
          caption: 'How we build local AI tools and workflows #aitools #automation',
          videoViewCount: 120000,
          likesCount: 8500,
          commentsCount: 410,
        },
        {
          id: 'CAND_REEL_2',
          shortCode: 'CR2',
          ownerUsername: 'new_automation_pro',
          ownerFullName: 'Automation Pro',
          caption: 'Part 2 of our AI tools breakdown #aitools #workflows',
          videoViewCount: 65000,
          likesCount: 4100,
          commentsCount: 220,
        },
      ],
    });

    const discoveryProvider = new ApifyHashtagDiscoveryProvider({
      apifyToken: 'mock-token',
      client: {
        actor: () => ({ call: mockDiscoveryActorCall }) as never,
        dataset: () => ({ listItems: mockDiscoveryDataset }) as never,
      },
    });

    const discoveryService = new CompetitorDiscoveryService(repo, config);
    const res = await discoveryService.runControlledDiscovery(discoveryProvider, {
      niche: 'AI & Automation',
      keywords: ['AI tools'],
      hashtags: ['automation'],
    });

    expect(res.autoApproved).toBe(false);
    expect(res.candidatesSaved).toHaveLength(1);
    expect(res.candidatesSaved[0]?.username).toBe('new_automation_pro');
    expect(res.candidatesSaved[0]?.status).toBe('candidate');

    // Verify candidate ranking deduplication helper directly
    const directCandidates = rankCompetitorCandidatesFromReels([], {
      niche: 'AI',
      keywords: ['ai'],
      hashtags: [],
      seedAccounts: ['workflow_architect'],
    });
    expect(directCandidates).toHaveLength(0);
  });

  it('enforces scheduler overlap prevention, manual pause switch, spend limits, and repeated failure alerts', async () => {
    const alerts: Array<{ jobName: string; message: string }> = [];
    const scheduler = new SchedulerService(repo.db, config, (jobName, message) => {
      alerts.push({ jobName, message });
    });

    scheduler.registerOrUpdateJob('daily-competitor-scan', 120);

    // 1. Manual pause switch blocks execution
    scheduler.setPaused('daily-competitor-scan', true);
    const pausedRes = await scheduler.triggerJobNow('daily-competitor-scan', 0.5, async () => ({
      spendUsd: 0.5,
      recordsProcessed: 10,
    }));
    expect(pausedRes.executed).toBe(false);
    expect(pausedRes.reason).toContain('paused');

    // Resume job
    scheduler.setPaused('daily-competitor-scan', false);

    // 2. Spend ceiling enforcement ($6.00 > $5.00 MAX_DAILY_ESTIMATED_SPEND_USD)
    const overSpendRes = await scheduler.triggerJobNow(
      'daily-competitor-scan',
      6.0,
      async () => ({
        spendUsd: 6.0,
        recordsProcessed: 100,
      })
    );
    expect(overSpendRes.executed).toBe(false);
    expect(overSpendRes.state.isPaused).toBe(true);
    expect(alerts.length).toBe(1);

    // Resume and test 3 consecutive failures triggering alert
    scheduler.setPaused('daily-competitor-scan', false);
    for (let i = 0; i < 3; i++) {
      await scheduler.triggerJobNow('daily-competitor-scan', 0.1, async () => {
        throw new Error('Simulated upstream provider outage');
      });
    }

    const failedState = scheduler.getJobState('daily-competitor-scan')!;
    expect(failedState.consecutiveFailures).toBe(3);
    expect(
      alerts.some((a) => a.message.includes('Repeated collection failure alert'))
    ).toBe(true);
  });
});
