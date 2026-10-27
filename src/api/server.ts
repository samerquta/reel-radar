import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppConfig, loadConfig, requireApifyCredentials, resolveApifyTokenFromFiles, saveApifyKey } from '../config/env.js';
import { createDatabase, runMigrations } from '../db/database.js';
import { ReelRadarRepository } from '../db/repository.js';
import { CollectionWorkflowService } from '../services/collection-service.js';
import { CompetitorDiscoveryService } from '../services/discovery-service.js';
import { ApifyHashtagDiscoveryProvider } from '../providers/apify-discovery-provider.js';
import { ApifyInstagramReelProvider } from '../providers/apify-reel-provider.js';
import {
  EvidenceBackedAnalysisProvider,
  ConfigurableTranscriptProvider,
} from '../providers/analysis-provider.js';
import { ReportGeneratorService } from '../reports/report-generator.js';
import { SchedulerService } from '../services/scheduler-service.js';

export function buildServer(
  customConfig?: AppConfig,
  customRepo?: ReelRadarRepository
): FastifyInstance {
  const config = customConfig ?? loadConfig();
  const repo =
    customRepo ??
    (() => {
      const db = createDatabase(config.DATABASE_PATH);
      runMigrations(db);
      return new ReelRadarRepository(db);
    })();

  const analysisProvider = new EvidenceBackedAnalysisProvider({
    providerType: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    openAiApiKey: config.OPENAI_API_KEY,
  });
  const transcriptProvider = new ConfigurableTranscriptProvider(config.TRANSCRIPT_PROVIDER);
  const collectionService = new CollectionWorkflowService(
    repo,
    config,
    analysisProvider,
    transcriptProvider
  );
  const discoveryService = new CompetitorDiscoveryService(repo, config);
  const reportService = new ReportGeneratorService(repo);
  const schedulerService = new SchedulerService(repo.db, config);

  const app = Fastify({ logger: false });

  // Serve Frontend UI at "/"
  app.get('/', async (_req, reply) => {
    const htmlPath = path.resolve(process.cwd(), 'src/ui/index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      return reply.type('text/html; charset=utf-8').send(html);
    }
    return reply.code(404).send('Frontend index.html not found');
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'reel-radar',
    timestamp: new Date().toISOString(),
  }));

  app.get('/status', async () => {
    const accounts = repo.listAccounts();
    const reels = repo.listAllReels();
    const scores = repo.listViralScoresOrdered();
    const runs = repo.listResearchRuns(10);
    const jobs = schedulerService.listJobs();
    const currentToken = config.APIFY_TOKEN || resolveApifyTokenFromFiles();
    const maskedKey = currentToken
      ? (currentToken.length > 14 ? `${currentToken.slice(0, 10)}...${currentToken.slice(-4)}` : '••••••••')
      : null;

    return {
      accounts: {
        total: accounts.length,
        active: accounts.filter((a) => a.status === 'active').length,
        candidate: accounts.filter((a) => a.status === 'candidate').length,
        excluded: accounts.filter((a) => a.status === 'excluded').length,
      },
      reelsCount: reels.length,
      scoredReelsCount: scores.length,
      apifyConfigured: Boolean(currentToken && currentToken.trim().length > 0),
      maskedKey,
      recentRuns: runs,
      scheduledJobs: jobs,
    };
  });

  // Save/Update Apify API key from Web UI settings
  app.post('/api/settings/key', async (request, reply) => {
    const bodySchema = z.object({
      token: z.string().min(1, 'Token cannot be empty'),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Please provide a valid Apify API key.' });
    }
    const cleanToken = parsed.data.token.trim();
    saveApifyKey(cleanToken);
    config.APIFY_TOKEN = cleanToken;
    const maskedKey = cleanToken.length > 14 ? `${cleanToken.slice(0, 10)}...${cleanToken.slice(-4)}` : '••••••••';
    return {
      status: 'ok',
      message: 'Apify API key saved successfully to apify-key.txt!',
      maskedKey,
    };
  });

  app.get('/accounts', async () => ({
    accounts: repo.listAccounts(),
  }));

  // Unified Reels Feed endpoint supporting tab=viral | tab=new & keyword filtering
  app.get('/reels', async (request) => {
    const querySchema = z.object({
      tab: z.enum(['viral', 'new']).optional().default('viral'),
      q: z.string().optional().default(''),
    });
    const { tab, q } = querySchema.parse(request.query);

    let scores = repo.listViralScoresOrdered();
    if (scores.length === 0) {
      scores = collectionService.recalculateAllViralScores();
    }
    const scoreMap = new Map(scores.map((s) => [s.reelId, s]));
    const allReels = repo.listAllReels();

    const searchTerms = q
      .toLowerCase()
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);

    const enriched = allReels.map((reel) => {
      const account = repo.getAccountById(reel.accountId);
      const latestSnap = repo.getLatestSnapshotForReel(reel.id);
      const score = scoreMap.get(reel.id) ?? null;
      const analysis = repo.getLatestAnalysisForReel(reel.id);

      const views =
        score?.explanation.effectiveViews ??
        latestSnap?.views ??
        latestSnap?.plays ??
        null;

      return {
        id: reel.id,
        externalId: reel.externalId,
        creator: account?.username ?? 'unknown',
        creatorDisplayName: account?.displayName ?? null,
        creatorProfileUrl:
          account?.profileUrl ?? `https://www.instagram.com/${account?.username ?? ''}/`,
        accountStatus: account?.status ?? 'candidate',
        niche: account?.niche ?? null,
        reelUrl: reel.canonicalUrl,
        thumbnailUrl: reel.thumbnailUrl,
        mediaUrl: reel.mediaUrl,
        caption: reel.caption,
        hashtags: reel.hashtags,
        publishedAt: reel.publishedAt,
        collectedAt: latestSnap?.collectedAt ?? reel.createdAt,
        durationSeconds: reel.durationSeconds,
        views,
        likes: latestSnap?.likes ?? null,
        comments: latestSnap?.comments ?? null,
        shares: latestSnap?.shares ?? null,
        score: score?.overallScore ?? 0,
        classification: score?.explanation.classification ?? 'Insufficient evidence',
        outlierRatio: score?.outlierRatio ?? null,
        baselineViews: score?.baselineViews ?? null,
        baselineConfidence: score?.explanation.baselineConfidence ?? 'insufficient',
        engagementRate: score?.engagementRate ?? null,
        growthRate: score?.growthRate ?? null,
        reasons: score?.explanation.reasons ?? [],
        analysis: analysis?.analysisJson ?? null,
      };
    });

    const filtered =
      searchTerms.length === 0
        ? enriched
        : enriched.filter((item) => {
            const haystack = [
              item.creator,
              item.creatorDisplayName ?? '',
              item.caption ?? '',
              item.hashtags.join(' '),
              item.niche ?? '',
              item.analysis?.topic ?? '',
              item.analysis?.hook ?? '',
            ]
              .join(' ')
              .toLowerCase();
            return searchTerms.some((term) => haystack.includes(term));
          });

    if (tab === 'new') {
      filtered.sort((a, b) => {
        const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        if (timeB !== timeA) return timeB - timeA;
        return (b.views ?? 0) - (a.views ?? 0);
      });
    } else {
      // Viral tab: sort by overallScore DESC, then views DESC
      filtered.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.views ?? 0) - (a.views ?? 0);
      });
    }

    return {
      tab,
      query: q,
      totalCount: enriched.length,
      filteredCount: filtered.length,
      items: filtered,
    };
  });

  app.get('/reels/viral', async () => {
    const scores = repo.listViralScoresOrdered();
    return {
      items: scores.map((score, idx) => {
        const reel = repo.getReelById(score.reelId);
        const account = reel ? repo.getAccountById(reel.accountId) : null;
        const analysis = repo.getLatestAnalysisForReel(score.reelId);
        return {
          rank: idx + 1,
          creator: account?.username ?? 'unknown',
          reelUrl: reel?.canonicalUrl ?? null,
          publishedAt: reel?.publishedAt ?? null,
          score: score.overallScore,
          classification: score.explanation.classification,
          outlierRatio: score.outlierRatio,
          baselineViews: score.baselineViews,
          views: score.explanation.effectiveViews,
          engagementRate: score.engagementRate,
          growthRate: score.growthRate,
          analysis: analysis?.analysisJson ?? null,
        };
      }),
    };
  });

  // Trigger live discovery or profile collection from the UI Run button
  app.post('/api/run', async (request, reply) => {
    const bodySchema = z.object({
      query: z.string().min(1),
      maxPosts: z.coerce.number().int().min(1).max(50).optional().default(12),
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Please enter at least one keyword, hashtag, or @username.',
      });
    }

    const rawTokens = parsed.data.query
      .split(/[,]+/)
      .flatMap((part) => part.trim().split(/\s+/))
      .map((t) => t.trim())
      .filter(Boolean);

    const usernames = rawTokens
      .filter((t) => t.startsWith('@'))
      .map((u) => u.replace(/^@/, '').toLowerCase())
      .filter(Boolean);

    const hashtags = rawTokens
      .filter((t) => !t.startsWith('@'))
      .map((h) => h.replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    const token = requireApifyCredentials(config);
    let discoveredCount = 0;

    if (usernames.length > 0) {
      const reelProvider = new ApifyInstagramReelProvider({
        apifyToken: token,
        actorId: config.APIFY_REEL_ACTOR_ID,
        maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
        defaultResultsLimit: parsed.data.maxPosts,
      });
      const colSummary = await collectionService.executeCollection(reelProvider, {
        usernames,
        limitPerProfile: parsed.data.maxPosts,
        forceRefresh: true,
        mode: 'competitor_monitoring',
        autoScore: true,
      });
      discoveredCount += colSummary.recordsDiscovered;
    }

    if (hashtags.length > 0) {
      const discoveryProvider = new ApifyHashtagDiscoveryProvider({
        apifyToken: token,
        actorId: config.APIFY_DISCOVERY_ACTOR_ID,
        defaultMaxPostsPerQuery: parsed.data.maxPosts,
      });
      const discSummary = await discoveryService.runControlledDiscovery(discoveryProvider, {
        niche: hashtags.join(', '),
        hashtags,
        keywords: [],
        maxPostsPerQuery: parsed.data.maxPosts,
      });
      discoveredCount += discSummary.discoveredReelsCount;
    }

    const scores = collectionService.recalculateAllViralScores();
    await collectionService.analyzeTopEligibleReels(25);
    reportService.generateAllReports();

    return {
      status: 'completed',
      query: parsed.data.query,
      discoveredCount,
      totalScored: scores.length,
    };
  });

  app.post('/score', async () => {
    const scores = collectionService.recalculateAllViralScores();
    return { scoredCount: scores.length };
  });

  app.post('/report', async () => {
    return reportService.generateAllReports();
  });

  return app;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const config = loadConfig();
  const server = buildServer(config);
  server
    .listen({ port: config.PORT, host: config.HOST })
    .then((address) => {
      console.log(`Reel Radar UI & API listening at ${address}`);
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
