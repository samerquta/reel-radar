import fs from 'node:fs';
import path from 'node:path';
import { ReelRadarRepository } from '../db/repository.js';
import { calculateMedian, resolveEffectiveViews } from '../domain/scoring.js';
import { ContentIdea, Reel, ReelAnalysis, ViralScore } from '../domain/entities.js';

export interface GeneratedReportsResult {
  outputDir: string;
  files: {
    viralReelsMd: string;
    competitorAccountsCsv: string;
    emergingTopicsMd: string;
    contentOpportunitiesMd: string;
    collectionHealthMd: string;
  };
}

function escapeCsvField(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class ReportGeneratorService {
  constructor(private readonly repo: ReelRadarRepository) {}

  generateAllReports(outputDir: string = path.resolve('./reports')): GeneratedReportsResult {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const generatedAt = new Date().toISOString();
    const allReels = this.repo.listAllReels();
    const pubDates = allReels
      .map((r) => r.publishedAt)
      .filter((d): d is string => Boolean(d))
      .sort();

    const researchPeriod =
      pubDates.length > 0
        ? `${pubDates[0]!.slice(0, 10)} to ${pubDates[pubDates.length - 1]!.slice(0, 10)}`
        : 'N/A (No dated Reels)';

    const viralReelsPath = path.join(outputDir, 'viral-reels.md');
    const competitorCsvPath = path.join(outputDir, 'competitor-accounts.csv');
    const emergingTopicsPath = path.join(outputDir, 'emerging-topics.md');
    const contentOppsPath = path.join(outputDir, 'content-opportunities.md');
    const collectionHealthPath = path.join(outputDir, 'collection-health.md');

    fs.writeFileSync(
      viralReelsPath,
      this.buildViralReelsMarkdown(generatedAt, researchPeriod),
      'utf-8'
    );
    fs.writeFileSync(
      competitorCsvPath,
      this.buildCompetitorAccountsCsv(generatedAt, researchPeriod),
      'utf-8'
    );
    fs.writeFileSync(
      emergingTopicsPath,
      this.buildEmergingTopicsMarkdown(generatedAt, researchPeriod),
      'utf-8'
    );
    fs.writeFileSync(
      contentOppsPath,
      this.buildContentOpportunitiesMarkdown(generatedAt, researchPeriod),
      'utf-8'
    );
    fs.writeFileSync(
      collectionHealthPath,
      this.buildCollectionHealthMarkdown(generatedAt, researchPeriod),
      'utf-8'
    );

    return {
      outputDir,
      files: {
        viralReelsMd: viralReelsPath,
        competitorAccountsCsv: competitorCsvPath,
        emergingTopicsMd: emergingTopicsPath,
        contentOpportunitiesMd: contentOppsPath,
        collectionHealthMd: collectionHealthPath,
      },
    };
  }

  public buildViralReelsMarkdown(generatedAt: string, researchPeriod: string): string {
    const scores = this.repo.listViralScoresOrdered();
    const lines: string[] = [
      '# REEL RADAR — Ranked Viral Reels Intelligence Report',
      '',
      `- **Generated At (UTC):** \`${generatedAt}\``,
      `- **Research Period:** \`${researchPeriod}\``,
      `- **Total Scored Reels:** ${scores.length}`,
      '',
      '> **Methodology Note:** Classifications (`Strong outlier`, `Breakout`, `Emerging`, `High absolute reach`, `Insufficient evidence`) reflect measured creator-relative patterns and historical velocity—not guaranteed future virality.',
      '',
    ];

    if (scores.length === 0) {
      lines.push('_No scored Reels available. Run `pnpm cli score` after importing or collecting Reels._');
      return lines.join('\n');
    }

    lines.push(
      '| Rank | Creator | Classification | Score | Views | Baseline | Outlier Ratio | Engagement | Growth | Confidence | Source Link |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
    );

    scores.forEach((s, idx) => {
      const reel = this.repo.getReelById(s.reelId);
      if (!reel) return;
      const account = this.repo.getAccountById(reel.accountId);
      const username = account ? `@${account.username}` : 'unknown';
      const viewsStr =
        s.explanation.effectiveViews !== null
          ? s.explanation.effectiveViews.toLocaleString()
          : 'N/A';
      const baselineStr =
        s.baselineViews !== null ? Math.round(s.baselineViews).toLocaleString() : 'N/A';
      const ratioStr = s.outlierRatio !== null ? `${s.outlierRatio.toFixed(2)}x` : 'N/A';
      const engStr =
        s.engagementRate !== null ? `${(s.engagementRate * 100).toFixed(2)}%` : 'N/A';
      const growthStr =
        s.growthRate !== null ? `+${s.growthRate.toFixed(0)}/hr` : 'Single snap';

      lines.push(
        `| ${idx + 1} | ${username} | **${s.explanation.classification}** | ${s.overallScore.toFixed(
          1
        )} | ${viewsStr} | ${baselineStr} | ${ratioStr} | ${engStr} | ${growthStr} | ${
          s.explanation.baselineConfidence
        } (n=${s.explanation.comparableReelCount}) | [Reel](${reel.canonicalUrl}) |`
      );
    });

    lines.push('', '---', '', '## Detailed Breakout Evidence & AI Analysis', '');

    scores.slice(0, 15).forEach((s, idx) => {
      const reel = this.repo.getReelById(s.reelId);
      if (!reel) return;
      const account = this.repo.getAccountById(reel.accountId);
      const latestSnap = this.repo.getLatestSnapshotForReel(reel.id);
      const analysis = this.repo.getLatestAnalysisForReel(reel.id);

      lines.push(
        `### #${idx + 1} — @${account?.username ?? 'unknown'} (${s.explanation.classification} — Score: ${s.overallScore.toFixed(1)}/100)`,
        `- **Reel URL:** ${reel.canonicalUrl}`,
        `- **Publication Date:** ${reel.publishedAt ?? 'Unavailable'}`,
        `- **Current Metrics:** Views: ${
          s.explanation.effectiveViews?.toLocaleString() ?? 'N/A'
        } | Likes: ${latestSnap?.likes?.toLocaleString() ?? 'N/A'} | Comments: ${
          latestSnap?.comments?.toLocaleString() ?? 'N/A'
        } | Shares: ${latestSnap?.shares?.toLocaleString() ?? 'N/A'} (${
          s.engagementRate !== null ? `${(s.engagementRate * 100).toFixed(2)}% ER` : 'ER N/A'
        })`,
        `- **Creator Baseline:** ${
          s.baselineViews !== null ? `${Math.round(s.baselineViews).toLocaleString()} median views` : 'N/A'
        } (Confidence: \`${s.explanation.baselineConfidence}\`, Comparable Sample: ${
          s.explanation.comparableReelCount
        } Reels)`,
        `- **Outlier Ratio:** ${s.outlierRatio !== null ? `${s.outlierRatio.toFixed(2)}x` : 'N/A'}`,
        `- **Growth Velocity:** ${s.explanation.growth.note}`,
        `- **Why It Was Flagged:** ${s.explanation.reasons.join(' ')}`
      );

      if (s.explanation.warnings.length > 0) {
        lines.push(`- **Caveats / Warnings:** ${s.explanation.warnings.join(' | ')}`);
      }

      if (analysis) {
        lines.push(
          `- **Analysis Summary (Model: \`${analysis.model}\`, Confidence: ${(
            analysis.confidence * 100
          ).toFixed(0)}%):**`,
          `  - **Hook:** ${analysis.hook}`,
          `  - **Topic:** ${analysis.topic}`,
          `  - **Target Audience:** ${analysis.targetAudience}`,
          `  - **Narrative Structure:** ${analysis.narrativeStructure.join(' -> ')}`,
          `  - **Emotional Trigger:** ${analysis.emotionalTrigger}`,
          `  - **Call To Action:** ${analysis.callToAction}`,
          `  - **Reusable Content Pattern:** ${analysis.contentPattern}`
        );
        if (analysis.analysisJson.limitations.length > 0) {
          lines.push(
            `  - **Analysis Limitations:** ${analysis.analysisJson.limitations.join(' ')}`
          );
        }
      } else {
        lines.push(`- **Analysis Summary:** _Not yet analyzed. Run \`pnpm cli analyze --top 20\`._`);
      }

      lines.push('');
    });

    return lines.join('\n');
  }

  public buildCompetitorAccountsCsv(generatedAt: string, researchPeriod: string): string {
    const accounts = this.repo.listAccounts();
    const header = [
      'accountUrl',
      'username',
      'status',
      'niche',
      'followerCount',
      'sampleSize',
      'medianViews',
      'breakoutCount',
      'latestScan',
      'discoveryReason',
      'reportGeneratedAt',
      'researchPeriod',
    ].join(',');

    const rows: string[] = [header];

    for (const acc of accounts) {
      const reels = this.repo.listReelsByAccount(acc.id);
      const viewsList: number[] = [];
      let breakoutCount = 0;

      for (const reel of reels) {
        const latest = this.repo.getLatestSnapshotForReel(reel.id);
        const v = latest ? resolveEffectiveViews(latest) : null;
        if (v !== null && v > 0) {
          viewsList.push(v);
        }
        const score = this.repo.getViralScoreForReel(reel.id);
        if (
          score &&
          (score.explanation.classification === 'Strong outlier' ||
            score.explanation.classification === 'Breakout')
        ) {
          breakoutCount++;
        }
      }

      const medianViews = calculateMedian(viewsList);

      rows.push(
        [
          escapeCsvField(acc.profileUrl),
          escapeCsvField(acc.username),
          escapeCsvField(acc.status),
          escapeCsvField(acc.niche ?? 'Uncategorized'),
          escapeCsvField(acc.followerCount),
          escapeCsvField(reels.length),
          escapeCsvField(medianViews !== null ? Math.round(medianViews) : null),
          escapeCsvField(breakoutCount),
          escapeCsvField(acc.lastScannedAt),
          escapeCsvField(acc.discoveryReason ?? acc.discoverySource),
          escapeCsvField(generatedAt),
          escapeCsvField(researchPeriod),
        ].join(',')
      );
    }

    return rows.join('\n') + '\n';
  }

  public buildEmergingTopicsMarkdown(generatedAt: string, researchPeriod: string): string {
    const allReels = this.repo.listAllReels();
    const lines: string[] = [
      '# REEL RADAR — Cross-Creator Emerging Topics Report',
      '',
      `- **Generated At (UTC):** \`${generatedAt}\``,
      `- **Research Period:** \`${researchPeriod}\``,
      '',
      '> **Strict Multi-Creator Rule:** A topic or hashtag cluster is only reported as an emerging trend when observed across **at least 2 distinct creators**. Single-creator topics are never claimed as platform trends.',
      '',
    ];

    interface TopicBucket {
      label: string;
      creatorIds: Set<string>;
      creatorUsernames: Set<string>;
      reels: Array<{
        reel: Reel;
        username: string;
        views: number | null;
        outlierRatio: number | null;
      }>;
    }

    const buckets = new Map<string, TopicBucket>();

    for (const reel of allReels) {
      const account = this.repo.getAccountById(reel.accountId);
      const username = account?.username ?? 'unknown';
      const latestSnap = this.repo.getLatestSnapshotForReel(reel.id);
      const score = this.repo.getViralScoreForReel(reel.id);
      const analysis = this.repo.getLatestAnalysisForReel(reel.id);
      const views = latestSnap ? resolveEffectiveViews(latestSnap) : null;

      // Group by both normalized hashtags and analyzed semantic topics
      const keys = new Set<string>();
      for (const tag of reel.hashtags) {
        keys.add(`#${tag}`);
      }
      if (analysis?.topic && analysis.topic !== 'General Creator Content') {
        keys.add(`Topic: ${analysis.topic}`);
      }

      for (const key of keys) {
        const existing = buckets.get(key) ?? {
          label: key,
          creatorIds: new Set<string>(),
          creatorUsernames: new Set<string>(),
          reels: [],
        };
        existing.creatorIds.add(reel.accountId);
        existing.creatorUsernames.add(username);
        existing.reels.push({
          reel,
          username,
          views,
          outlierRatio: score?.outlierRatio ?? null,
        });
        buckets.set(key, existing);
      }
    }

    // Filter strictly to >= 2 distinct creators
    const multiCreatorTopics = Array.from(buckets.values())
      .filter((b) => b.creatorIds.size >= 2)
      .sort((a, b) => {
        if (b.creatorIds.size !== a.creatorIds.size) {
          return b.creatorIds.size - a.creatorIds.size;
        }
        return b.reels.length - a.reels.length;
      });

    if (multiCreatorTopics.length === 0) {
      lines.push(
        '_No topics currently have supporting Reels across 2 or more distinct creators._'
      );
      return lines.join('\n');
    }

    for (const bucket of multiCreatorTopics) {
      const avgOutlier =
        bucket.reels.reduce((acc, r) => acc + (r.outlierRatio ?? 1), 0) / bucket.reels.length;

      lines.push(
        `## ${bucket.label}`,
        `- **Distinct Creators (${bucket.creatorIds.size}):** ${Array.from(
          bucket.creatorUsernames
        )
          .map((u) => `@${u}`)
          .join(', ')}`,
        `- **Supporting Reels Count:** ${bucket.reels.length}`,
        `- **Average Creator Outlier Ratio:** ${avgOutlier.toFixed(2)}x`,
        '',
        '### Supporting Evidence Reels:',
        ''
      );

      for (const item of bucket.reels) {
        lines.push(
          `- **@${item.username}** — [${item.reel.canonicalUrl}](${
            item.reel.canonicalUrl
          }) | Published: \`${item.reel.publishedAt?.slice(0, 10) ?? 'Unknown'}\` | Views: **${
            item.views?.toLocaleString() ?? 'N/A'
          }** (${item.outlierRatio !== null ? `${item.outlierRatio.toFixed(2)}x baseline` : 'N/A'})`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  public buildContentOpportunitiesMarkdown(
    generatedAt: string,
    researchPeriod: string
  ): string {
    const scores = this.repo.listViralScoresOrdered();
    const breakoutScores = scores.filter(
      (s) =>
        s.explanation.classification === 'Strong outlier' ||
        s.explanation.classification === 'Breakout' ||
        s.explanation.classification === 'Emerging'
    );

    this.repo.clearProposedContentIdeas();

    const ideas: Array<{
      idea: ContentIdea;
      sourceLinks: string[];
      whyWorthTesting: string;
    }> = [];

    const blueprintTemplates = [
      {
        title: 'The "Audit Before You Automate" Contrarian Breakdown',
        proposedHook:
          'Stop automating broken team habits. Run this 10-minute manual bottleneck score before building your next workflow.',
        audienceProblem:
          'Teams waste days building brittle automations for processes that should be simplified or eliminated first.',
        format:
          '35-second talking-head + split-screen whiteboard audit matrix (Eliminate -> Standardize -> Automate)',
        suggestedCTA:
          'Comment "MATRIX" for our 1-page automation readiness checklist.',
        originalityNotes:
          'Instead of copying competitors who jump straight into a 3-step tool tutorial, this flips the premise by showing what NOT to automate first, positioning us as pragmatic architects.',
      },
      {
        title: 'The Live Local-First Cost & Latency Teardown',
        proposedHook:
          'We benchmarked our monthly cloud SaaS stack against a single local SQLite + TypeScript worker. Here is the exact bill and latency diff.',
        audienceProblem:
          'Founders and developers suffer from SaaS subscription fatigue and slow API roundtrips across 4+ glued-together tools.',
        format:
          '40-second side-by-side terminal speed benchmark + real monthly invoice comparison table',
        suggestedCTA:
          'Save this teardown before your next quarterly SaaS renewal audit.',
        originalityNotes:
          'Combines the SaaS cost-saving angle from agency creators with live local engineering benchmarks (latency + deterministic schema reliability) rather than generic tool lists.',
      },
      {
        title: 'Unstructured Voice/Meeting Chaos to Validated Action Schema',
        proposedHook:
          'Why raw AI meeting summaries sit unread in Notion—and the strict JSON schema filter that turns calls into assigned tickets.',
        audienceProblem:
          'AI note-takers generate walls of text that nobody reads instead of deterministic, owner-assigned tasks.',
        format:
          '30-second before/after comparison: messy wall-of-text summary vs strict Zod-validated task payload',
        suggestedCTA:
          'Comment "SCHEMA" to get the exact validation prompt and webhook template.',
        originalityNotes:
          'Differentiates from standard "voice-to-Notion" demos by focusing on the failure mode of unread AI notes and enforcing strict schema validation.',
      },
    ];

    const topEvidence = breakoutScores.slice(0, 6);

    blueprintTemplates.forEach((tpl, idx) => {
      const supporting = topEvidence.slice(idx * 2, idx * 2 + 2);
      const fallbackSupporting = supporting.length > 0 ? supporting : topEvidence.slice(0, 2);

      const reelIds = fallbackSupporting.map((s) => s.reelId);
      const links: string[] = [];
      const metricProofs: string[] = [];

      for (const s of fallbackSupporting) {
        const r = this.repo.getReelById(s.reelId);
        const acc = r ? this.repo.getAccountById(r.accountId) : null;
        if (r) {
          links.push(r.canonicalUrl);
          metricProofs.push(
            `@${acc?.username ?? 'creator'} achieved ${
              s.outlierRatio?.toFixed(2) ?? 'N/A'
            }x baseline (${s.explanation.effectiveViews?.toLocaleString() ?? 'N/A'} views)`
          );
        }
      }

      const saved = this.repo.saveContentIdea({
        niche: 'AI & Automation',
        proposedHook: tpl.proposedHook,
        concept: tpl.title,
        audienceProblem: tpl.audienceProblem,
        format: tpl.format,
        suggestedCTA: tpl.suggestedCTA,
        evidenceReelIds: reelIds,
        originalityNotes: tpl.originalityNotes,
        status: 'proposed',
      });

      ideas.push({
        idea: saved,
        sourceLinks: links,
        whyWorthTesting:
          metricProofs.length > 0
            ? `Validated across breakout reference Reels where ${metricProofs.join(' and ')}.`
            : 'Addresses recurring workflow friction observed across monitored creators.',
      });
    });

    const lines: string[] = [
      '# REEL RADAR — Original Content Opportunities & Test Concepts',
      '',
      `- **Generated At (UTC):** \`${generatedAt}\``,
      `- **Research Period:** \`${researchPeriod}\``,
      '',
      '> **Originality Policy:** Every concept below extracts structural mechanics and audience pain points from verified breakout Reels while introducing a distinct angle, proof mechanism, and script structure.',
      '',
    ];

    ideas.forEach((item, idx) => {
      lines.push(
        `## Concept #${idx + 1}: ${item.idea.concept}`,
        `- **Proposed Hook:** "${item.idea.proposedHook}"`,
        `- **Audience Problem:** ${item.idea.audienceProblem}`,
        `- **Suggested Structure & Format:** ${item.idea.format}`,
        `- **Suggested CTA:** ${item.idea.suggestedCTA}`,
        `- **Supporting Source Links:** ${
          item.sourceLinks.length > 0
            ? item.sourceLinks.map((l) => `[${l}](${l})`).join(', ')
            : 'N/A'
        }`,
        `- **Why This Concept Is Worth Testing:** ${item.whyWorthTesting}`,
        `- **How It Differs From References (Originality Notes):** ${item.idea.originalityNotes}`,
        ''
      );
    });

    return lines.join('\n');
  }

  public buildCollectionHealthMarkdown(
    generatedAt: string,
    researchPeriod: string
  ): string {
    const runs = this.repo.listResearchRuns(30);
    const allReels = this.repo.listAllReels();
    const accounts = this.repo.listAccounts();

    let missingViews = 0;
    let missingLikes = 0;
    let missingShares = 0;
    let missingPublishedAt = 0;
    let missingTranscript = 0;

    for (const r of allReels) {
      if (!r.publishedAt) missingPublishedAt++;
      if (!r.transcript) missingTranscript++;
      const snap = this.repo.getLatestSnapshotForReel(r.id);
      if (!snap || (snap.views === null && snap.plays === null)) missingViews++;
      if (!snap || snap.likes === null) missingLikes++;
      if (!snap || snap.shares === null) missingShares++;
    }

    const nowMs = Date.now();
    const staleAccounts = accounts.filter((a) => {
      if (a.status !== 'active') return false;
      if (!a.lastScannedAt) return true;
      return nowMs - new Date(a.lastScannedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
    });

    const lines: string[] = [
      '# REEL RADAR — Collection Health & Data Completeness Report',
      '',
      `- **Generated At (UTC):** \`${generatedAt}\``,
      `- **Research Period:** \`${researchPeriod}\``,
      `- **Total Tracked Accounts:** ${accounts.length} (Active: ${
        accounts.filter((a) => a.status === 'active').length
      }, Candidate: ${accounts.filter((a) => a.status === 'candidate').length}, Excluded: ${
        accounts.filter((a) => a.status === 'excluded').length
      })`,
      `- **Total Stored Reels:** ${allReels.length}`,
      '',
      '## 1. Metric & Metadata Completeness',
      '',
      '| Field | Missing Count | Completeness % | Notes |',
      '| :--- | :--- | :--- | :--- |',
      `| Views / Plays | ${missingViews} / ${allReels.length} | ${
        allReels.length > 0 ? (((allReels.length - missingViews) / allReels.length) * 100).toFixed(1) : '100.0'
      }% | Required for outlier ratio |`,
      `| Likes | ${missingLikes} / ${allReels.length} | ${
        allReels.length > 0 ? (((allReels.length - missingLikes) / allReels.length) * 100).toFixed(1) : '100.0'
      }% | Used for engagement rate |`,
      `| Shares | ${missingShares} / ${allReels.length} | ${
        allReels.length > 0 ? (((allReels.length - missingShares) / allReels.length) * 100).toFixed(1) : '100.0'
      }% | Optional separate virality signal |`,
      `| Published Timestamp | ${missingPublishedAt} / ${allReels.length} | ${
        allReels.length > 0
          ? (((allReels.length - missingPublishedAt) / allReels.length) * 100).toFixed(1)
          : '100.0'
      }% | Required for recency decay |`,
      `| Spoken Transcript | ${missingTranscript} / ${allReels.length} | ${
        allReels.length > 0
          ? (((allReels.length - missingTranscript) / allReels.length) * 100).toFixed(1)
          : '100.0'
      }% | Optional; never inferred when absent |`,
      '',
      '## 2. Stale Active Accounts (>7 Days Since Last Scan)',
      '',
    ];

    if (staleAccounts.length === 0) {
      lines.push('- All active accounts have been scanned within the last 7 days.');
    } else {
      for (const acc of staleAccounts) {
        lines.push(
          `- \`@${acc.username}\` (${acc.profileUrl}) — Last scanned: \`${
            acc.lastScannedAt ?? 'Never'
          }\``
        );
      }
    }

    lines.push('', '## 3. Recent Research Runs & Provider Failures', '');

    if (runs.length === 0) {
      lines.push('_No research runs recorded yet._');
    } else {
      lines.push(
        '| Run ID | Provider | Mode | Status | Started At | Discovered | Inserted | Updated | Errors |',
        '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
      );
      for (const r of runs) {
        lines.push(
          `| \`${r.id.slice(0, 8)}\` | \`${r.provider}\` | \`${r.mode}\` | **${r.status}** | \`${
            r.startedAt
          }\` | ${r.recordsDiscovered} | ${r.recordsInserted} | ${r.recordsUpdated} | ${
            r.errors.length
          } |`
        );
      }

      const runsWithErrors = runs.filter((r) => r.errors.length > 0);
      if (runsWithErrors.length > 0) {
        lines.push('', '### Recorded Provider Error Details:', '');
        for (const r of runsWithErrors) {
          for (const err of r.errors) {
            lines.push(
              `- Run \`${r.id.slice(0, 8)}\` [${err.stage}] Target=\`${
                err.target ?? 'N/A'
              }\`: ${err.message} (Transient: ${Boolean(err.isTransient)})`
            );
          }
        }
      }
    }

    return lines.join('\n');
  }
}
