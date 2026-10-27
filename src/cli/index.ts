import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, requireApifyCredentials } from '../config/env.js';
import { createDatabase, runMigrations } from '../db/database.js';
import { ReelRadarRepository } from '../db/repository.js';
import { ApifyInstagramReelProvider } from '../providers/apify-reel-provider.js';
import { ApifyHashtagDiscoveryProvider } from '../providers/apify-discovery-provider.js';
import { ManualImportProvider } from '../providers/manual-import-provider.js';
import {
  ConfigurableTranscriptProvider,
  EvidenceBackedAnalysisProvider,
} from '../providers/analysis-provider.js';
import { CollectionWorkflowService } from '../services/collection-service.js';
import { CompetitorDiscoveryService } from '../services/discovery-service.js';
import { ReportGeneratorService } from '../reports/report-generator.js';
import { SchedulerService } from '../services/scheduler-service.js';
import { AccountStatus } from '../domain/entities.js';

export function buildCliProgram(customDbPath?: string): Command {
  const config = loadConfig(
    customDbPath ? { ...process.env, DATABASE_PATH: customDbPath } : process.env
  );
  const db = createDatabase(config.DATABASE_PATH);
  runMigrations(db);

  const repo = new ReelRadarRepository(db);
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
  const schedulerService = new SchedulerService(db, config);

  const program = new Command();
  program
    .name('reel-radar')
    .description('REEL RADAR — Instagram Viral Intelligence Platform CLI')
    .version('1.0.0');

  // --- Account Subcommands ---
  const accountCmd = program
    .command('account')
    .description('Manage competitor watchlist accounts (active, candidate, excluded)');

  accountCmd
    .command('add <username>')
    .description('Add or activate a public Instagram account on the competitor watchlist')
    .option('-n, --niche <niche>', 'Assign a niche label', 'AI & Automation')
    .option('-r, --reason <reason>', 'Discovery or monitoring reason', 'Manual CLI addition')
    .action((username: string, opts: { niche: string; reason: string }) => {
      const cleanUsername = z
        .string()
        .min(1)
        .regex(/^[a-zA-Z0-9._@]+$/, 'Invalid Instagram username format')
        .parse(username);

      const acc = repo.upsertAccount({
        username: cleanUsername,
        niche: opts.niche,
        discoverySource: 'cli_manual',
        discoveryReason: opts.reason,
        status: 'active',
      });
      console.log(
        `Added/Activated account @${acc.username} [status=${acc.status}, niche=${
          acc.niche ?? 'N/A'
        }] (${acc.profileUrl})`
      );
    });

  accountCmd
    .command('list')
    .description('List tracked competitor accounts')
    .option('-s, --status <status>', 'Filter by status (active, candidate, excluded)')
    .action((opts: { status?: string }) => {
      const statusFilter = opts.status
        ? z.enum(['active', 'candidate', 'excluded']).parse(opts.status)
        : undefined;
      const accounts = repo.listAccounts(statusFilter as AccountStatus | undefined);
      if (accounts.length === 0) {
        console.log('No competitor accounts found.');
        return;
      }
      console.table(
        accounts.map((a) => ({
          username: `@${a.username}`,
          status: a.status,
          niche: a.niche ?? '-',
          followers: a.followerCount ?? 'N/A',
          reels: repo.listReelsByAccount(a.id).length,
          lastScannedAt: a.lastScannedAt ?? 'Never',
        }))
      );
    });

  accountCmd
    .command('exclude <username>')
    .description('Exclude an account from active monitoring and discovery')
    .action((username: string) => {
      const updated = repo.updateAccountStatus(username, 'excluded');
      if (!updated) {
        console.error(`Account @${username.replace(/^@/, '')} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Account @${updated.username} marked as status=excluded.`);
    });

  accountCmd
    .command('approve <username>')
    .description('Approve a discovered candidate account into the active watchlist')
    .action((username: string) => {
      const updated = repo.updateAccountStatus(username, 'active');
      if (!updated) {
        console.error(`Account @${username.replace(/^@/, '')} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Candidate @${updated.username} approved to status=active.`);
    });

  // --- Collect Command ---
  program
    .command('collect')
    .description(
      'Collect recent public Reels from a specific username or all active watchlist accounts via Apify'
    )
    .option('-u, --username <username>', 'Specific Instagram username to collect')
    .option('-a, --active-accounts', 'Collect across all active watchlist accounts')
    .option(
      '-l, --limit <number>',
      'Maximum Reels per profile',
      String(config.DEFAULT_RESULTS_PER_PROFILE)
    )
    .option(
      '-d, --days <number>',
      'Optional lookback window in days (omit to fetch latest N Reels regardless of date)'
    )
    .option('--force', 'Bypass recent scan cache TTL')
    .option('--dry-run', 'Estimate cost and preview targets without starting external Apify jobs')
    .option('--confirm-large-job', 'Confirm execution when total expected Reels > 50')
    .action(
      async (opts: {
        username?: string;
        activeAccounts?: boolean;
        limit: string;
        days?: string;
        force?: boolean;
        dryRun?: boolean;
        confirmLargeJob?: boolean;
      }) => {
        const limit = z.coerce.number().int().min(1).max(200).parse(opts.limit);
        const days = opts.days
          ? z.coerce.number().int().min(1).max(3650).parse(opts.days)
          : undefined;

        if (!opts.username && !opts.activeAccounts) {
          throw new Error(
            'Please specify either `--username <username>` or `--active-accounts`.'
          );
        }

        const targets = opts.username
          ? [opts.username]
          : repo.listAccounts('active').map((a) => a.username);

        const expectedReels = targets.length * limit;
        const estimatedCost = Number(((expectedReels / 1000) * 2.6).toFixed(4));
        console.log(
          `Collection Plan: ${targets.length} profile(s) x ${limit} max Reels = up to ${expectedReels} Reels | Estimated Apify Cost: ~$${estimatedCost.toFixed(
            4
          )}`
        );

        if (expectedReels > 50 && !opts.confirmLargeJob && !opts.dryRun) {
          throw new Error(
            `Safety Guardrail: Job requests up to ${expectedReels} Reels (>50). Pass --confirm-large-job to proceed or --dry-run to preview.`
          );
        }

        const token = opts.dryRun ? 'dry-run-token' : requireApifyCredentials(config);
        const provider = new ApifyInstagramReelProvider({
          apifyToken: token,
          actorId: config.APIFY_REEL_ACTOR_ID,
          maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
          defaultResultsLimit: limit,
        });

        const summary = await collectionService.executeCollection(provider, {
          usernames: opts.username ? [opts.username] : undefined,
          activeAccountsOnly: Boolean(opts.activeAccounts),
          limitPerProfile: limit,
          lookbackDays: days,
          forceRefresh: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          mode: 'competitor_monitoring',
          autoScore: true,
        });

        console.log(JSON.stringify(summary, null, 2));
      }
    );

  // --- Import Command ---
  program
    .command('import')
    .description(
      'Import Reels from a local JSON or CSV file without external API credentials'
    )
    .requiredOption('-f, --file <path>', 'Path to .json or .csv file')
    .option('--analyze', 'Automatically run evidence-backed analysis on imported Reels', true)
    .action(async (opts: { file: string; analyze?: boolean }) => {
      const resolved = path.resolve(opts.file);
      const provider = new ManualImportProvider(resolved);
      const summary = await collectionService.executeCollection(provider, {
        mode: 'manual_import',
        forceRefresh: true,
        autoScore: true,
        autoAnalyzeTopN: opts.analyze ? 25 : 0,
      });

      console.log(
        `Imported ${summary.recordsDiscovered} record(s) from ${path.basename(
          resolved
        )} (Inserted: ${summary.recordsInserted}, Updated: ${
          summary.recordsUpdated
        }, Scored: ${summary.scoredCount}, Analyzed: ${summary.analyzedCount})`
      );
    });

  // --- Discover Command ---
  program
    .command('discover')
    .description(
      'Discover viral Reels and candidate competitor accounts via hashtag/keyword search'
    )
    .option('-k, --keyword <keywords>', 'Comma-separated keywords or topic phrases to search')
    .option('-t, --hashtag <hashtags>', 'Comma-separated hashtags to search (e.g. ai,claude,chatgpt,motion)')
    .option('-n, --niche <niche>', 'Niche label for discovered candidates', 'AI & Motion')
    .option('-m, --max-posts <number>', 'Max Reels per query', '15')
    .option('--auto-approve', 'Automatically approve candidates to active status')
    .option('--dry-run', 'Show cost estimate without calling Apify')
    .action(
      async (opts: {
        keyword?: string;
        hashtag?: string;
        niche: string;
        maxPosts: string;
        autoApprove?: boolean;
        dryRun?: boolean;
      }) => {
        if (!opts.keyword && !opts.hashtag) {
          throw new Error('Provide at least one of `--keyword <text>` or `--hashtag <tag>`.');
        }
        const keywords = opts.keyword
          ? opts.keyword.split(',').map((k) => k.trim()).filter(Boolean)
          : [];
        const hashtags = opts.hashtag
          ? opts.hashtag.split(',').map((h) => h.trim().replace(/^#/, '')).filter(Boolean)
          : [];
        const maxPosts = z.coerce.number().int().min(1).max(100).parse(opts.maxPosts);
        const totalQueries = Math.max(1, keywords.length + hashtags.length);
        const estCost = Number((((maxPosts * totalQueries) / 1000) * 2.6).toFixed(4));
        console.log(
          `Discovery Plan: hashtags=[${hashtags.join(', ')}] keywords=[${keywords.join(
            ', '
          )}] | maxPostsPerQuery=${maxPosts} | Est. Apify Cost: ~$${estCost.toFixed(4)}`
        );

        if (opts.dryRun) {
          return;
        }

        const token = requireApifyCredentials(config);
        const provider = new ApifyHashtagDiscoveryProvider({
          apifyToken: token,
          actorId: config.APIFY_DISCOVERY_ACTOR_ID,
          defaultMaxPostsPerQuery: maxPosts,
        });

        const result = await discoveryService.runControlledDiscovery(provider, {
          niche: opts.niche,
          keywords,
          hashtags,
          maxPostsPerQuery: maxPosts,
          autoApprove: opts.autoApprove,
        });

        collectionService.recalculateAllViralScores();
        console.log(JSON.stringify(result, null, 2));
      }
    );

  // --- Score Command ---
  program
    .command('score')
    .description('Recalculate deterministic creator-relative viral outlier scores for all Reels')
    .action(() => {
      const scores = collectionService.recalculateAllViralScores();
      console.log(`Scored ${scores.length} Reel(s). Top results:`);
      console.table(
        scores.slice(0, 10).map((s, i) => {
          const r = repo.getReelById(s.reelId);
          const acc = r ? repo.getAccountById(r.accountId) : null;
          return {
            rank: i + 1,
            creator: `@${acc?.username ?? 'unknown'}`,
            score: s.overallScore,
            classification: s.explanation.classification,
            views: s.explanation.effectiveViews ?? 'N/A',
            baseline: s.baselineViews ?? 'N/A',
            outlierRatio: s.outlierRatio !== null ? `${s.outlierRatio.toFixed(2)}x` : 'N/A',
            confidence: s.explanation.baselineConfidence,
          };
        })
      );
    });

  // --- Analyze Command ---
  program
    .command('analyze')
    .description('Run evidence-backed content analysis on top-scoring eligible Reels')
    .option('--top <number>', 'Number of top Reels to analyze', '20')
    .action(async (opts: { top: string }) => {
      const topN = z.coerce.number().int().min(1).max(200).parse(opts.top);
      const count = await collectionService.analyzeTopEligibleReels(topN);
      console.log(
        `Completed evidence-backed analysis for ${count} eligible Reel(s) using provider "${analysisProvider.name}" (model=${analysisProvider.model}, promptVersion=${analysisProvider.promptVersion}).`
      );
    });

  // --- Report Command ---
  program
    .command('report')
    .description('Generate all 5 Markdown and CSV research reports')
    .option('-o, --output <dir>', 'Output directory for generated reports', './reports')
    .action((opts: { output: string }) => {
      const res = reportService.generateAllReports(path.resolve(opts.output));
      console.log('Generated Reel Radar Research Reports:');
      for (const [key, filePath] of Object.entries(res.files)) {
        console.log(`  - ${key}: ${filePath}`);
      }
    });

  // --- Status Command ---
  program
    .command('status')
    .description('Display database inventory, recent research runs, and scheduler state')
    .action(() => {
      const accounts = repo.listAccounts();
      const reels = repo.listAllReels();
      const scores = repo.listViralScoresOrdered();
      const analyses = repo.listAllAnalyses();
      const runs = repo.listResearchRuns(5);
      const jobs = schedulerService.listJobs();

      console.log('=== REEL RADAR PLATFORM STATUS ===');
      console.log(`Database Path: ${config.DATABASE_PATH}`);
      console.log(
        `Accounts: ${accounts.length} total (Active: ${
          accounts.filter((a) => a.status === 'active').length
        }, Candidate: ${accounts.filter((a) => a.status === 'candidate').length}, Excluded: ${
          accounts.filter((a) => a.status === 'excluded').length
        })`
      );
      console.log(
        `Reels: ${reels.length} total | Scored: ${scores.length} | Analyzed: ${analyses.length}`
      );
      console.log(
        `Apify Credentials Configured: ${Boolean(
          config.APIFY_TOKEN && config.APIFY_TOKEN.trim().length > 0
        )}`
      );
      if (runs.length > 0) {
        console.log('\nRecent Research Runs:');
        console.table(
          runs.map((r) => ({
            id: r.id.slice(0, 8),
            provider: r.provider,
            mode: r.mode,
            status: r.status,
            discovered: r.recordsDiscovered,
            inserted: r.recordsInserted,
            updated: r.recordsUpdated,
            errors: r.errors.length,
          }))
        );
      }
      if (jobs.length > 0) {
        console.log('\nScheduled Jobs:');
        console.table(jobs);
      }
    });

  // --- Schedule Subcommands ---
  const scheduleCmd = program
    .command('schedule')
    .description('Manage optional scheduled background scan jobs');

  scheduleCmd
    .command('register <jobName>')
    .option('-i, --interval <minutes>', 'Scan interval in minutes', '360')
    .action((jobName: string, opts: { interval: string }) => {
      const interval = z.coerce.number().int().min(5).parse(opts.interval);
      const state = schedulerService.registerOrUpdateJob(jobName, interval);
      console.log(`Registered job "${state.jobName}" (interval=${state.intervalMinutes}m).`);
    });

  scheduleCmd
    .command('pause <jobName>')
    .action((jobName: string) => {
      const state = schedulerService.setPaused(jobName, true);
      console.log(`Job "${state.jobName}" paused.`);
    });

  scheduleCmd
    .command('resume <jobName>')
    .action((jobName: string) => {
      const state = schedulerService.setPaused(jobName, false);
      console.log(`Job "${state.jobName}" resumed.`);
    });

  return program;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const program = buildCliProgram();
  program.parseAsync(process.argv).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
