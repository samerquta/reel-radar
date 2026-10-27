import {
  ContentAnalysisInput,
  ContentAnalysisProvider,
  TranscriptProvider,
  TranscriptResult,
} from './interfaces.js';
import { ReelAnalysisOutput, ReelAnalysisOutputSchema } from '../domain/entities.js';

export const PROMPT_VERSION = 'v1.0.0-evidence-backed';

/**
 * OptionalTranscriptProvider:
 * Does NOT download every video by default. Only transcribes selected videos when requested.
 * Explicitly documents supported languages, confidence, and cost per minute.
 */
export class ConfigurableTranscriptProvider implements TranscriptProvider {
  public readonly name: string;
  public readonly supportedLanguages = ['en', 'ar', 'es', 'fr', 'de', 'pt'];
  public readonly costPerMinuteUsd: number;

  constructor(private readonly mode: 'none' | 'mock' | 'openai-whisper' = 'none') {
    this.name = mode;
    this.costPerMinuteUsd = mode === 'openai-whisper' ? 0.006 : 0;
  }

  async transcribe(input: {
    reelId: string;
    canonicalUrl: string;
    mediaUrl: string | null;
    durationSeconds: number | null;
    existingTranscript?: string | null;
  }): Promise<TranscriptResult> {
    if (input.existingTranscript && input.existingTranscript.trim().length > 0) {
      return {
        transcript: input.existingTranscript,
        language: 'en',
        confidence: 0.95,
        costUsd: 0,
        providerName: 'existing-provider-transcript',
      };
    }

    if (this.mode === 'none') {
      return {
        transcript: null,
        language: null,
        confidence: 0,
        costUsd: 0,
        providerName: 'none',
        limitationNote:
          'Transcript not returned by Reel collection provider and optional transcription adapter is disabled (TRANSCRIPT_PROVIDER=none).',
      };
    }

    if (!input.mediaUrl) {
      return {
        transcript: null,
        language: null,
        confidence: 0,
        costUsd: 0,
        providerName: this.name,
        limitationNote: 'Direct mediaUrl is unavailable; cannot download audio for transcription.',
      };
    }

    const durationMins = Math.max(0.25, (input.durationSeconds ?? 30) / 60);
    const estimatedCost = Number((durationMins * this.costPerMinuteUsd).toFixed(5));

    if (this.mode === 'mock') {
      return {
        transcript: null,
        language: null,
        confidence: 0,
        costUsd: 0,
        providerName: 'mock',
        limitationNote:
          'Mock transcript provider does not fabricate spoken dialogue when transcript is absent.',
      };
    }

    return {
      transcript: null,
      language: null,
      confidence: 0,
      costUsd: estimatedCost,
      providerName: this.name,
      limitationNote: 'Live audio download skipped by default policy unless explicitly authorized.',
    };
  }
}

/**
 * Deterministic Evidence-Backed ContentAnalysisProvider (`heuristic-evidence-analyzer`)
 * and OpenAI LLM JSON Adapter (`openai-evidence-analyzer`).
 *
 * Strictly adheres to Section 9:
 * - Treats missing transcripts or video access explicitly in `limitations`.
 * - Never infers detailed editing, facial expressions, or scene changes from captions alone.
 * - Extracts general reusable patterns and validates output with Zod (`ReelAnalysisOutputSchema`).
 */
export class EvidenceBackedAnalysisProvider implements ContentAnalysisProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly promptVersion = PROMPT_VERSION;

  constructor(
    private readonly options: {
      providerType: 'mock' | 'openai';
      model?: string;
      openAiApiKey?: string;
      fetchImpl?: typeof fetch;
    }
  ) {
    this.name =
      options.providerType === 'openai'
        ? 'openai-evidence-analyzer'
        : 'deterministic-evidence-analyzer';
    this.model = options.model ?? 'gpt-4o-mini';
  }

  async analyzeReel(input: ContentAnalysisInput): Promise<ReelAnalysisOutput> {
    if (this.options.providerType === 'openai' && this.options.openAiApiKey) {
      return this.analyzeWithOpenAI(input);
    }
    return this.analyzeDeterministically(input);
  }

  private analyzeDeterministically(input: ContentAnalysisInput): ReelAnalysisOutput {
    const caption = (input.caption ?? '').trim();
    const transcript = (input.transcript ?? '').trim();
    const combinedText = `${transcript} ${caption}`.trim();
    const lowerText = combinedText.toLowerCase();

    const evidence: string[] = [];
    const limitations: string[] = [];

    if (!transcript) {
      limitations.push(
        'No spoken transcript available; analysis relies strictly on caption, hashtags, duration, and public performance metrics.'
      );
    } else {
      evidence.push(`Transcript available (${transcript.split(/\s+/).length} words).`);
    }

    if (!input.visualDescription) {
      limitations.push(
        'Direct video frame inspection was not performed; visual editing observations are restricted to duration/transcript pacing without inferring facial expressions or scene cuts.'
      );
    }

    // 1. Opening Hook extraction (never copy entire script; extract opening hook sentence)
    const sourceForHook = transcript || caption;
    let hook = 'unknown';
    if (sourceForHook.length > 0) {
      const firstSentence = sourceForHook.split(/(?<=[.!?])\s+/)[0]?.trim() ?? sourceForHook;
      hook = firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence;
      evidence.push(
        `Opening hook extracted from ${transcript ? 'transcript' : 'caption'}: "${hook}"`
      );
    } else {
      limitations.push('Both transcript and caption are missing; opening hook marked unknown.');
    }

    // 2. Topic classification from hashtags and text signals
    const tags = input.hashtags.map((h) => h.toLowerCase());
    let topic = 'General Creator Content';
    if (
      tags.some((t) => ['aitools', 'automation', 'workflows', 'llm', 'localai', 'voiceai'].includes(t)) ||
      lowerText.includes('workflow') ||
      lowerText.includes('automation')
    ) {
      if (lowerText.includes('saas') || lowerText.includes('subscription')) {
        topic = 'SaaS Consolidation & Self-Hosted Workflow Automation';
      } else if (lowerText.includes('transcript') || lowerText.includes('voice')) {
        topic = 'Voice & Meeting Transcript to Structured Data Pipelines';
      } else if (lowerText.includes('agent') || lowerText.includes('slack') || lowerText.includes('notion')) {
        topic = 'Multi-App AI Agent & Workspace Automation';
      } else {
        topic = 'Practical AI Tools & Developer Workflows';
      }
    } else if (tags.some((t) => ['devtools', 'sqlite', 'coding', 'terminal'].includes(t))) {
      topic = 'Developer Productivity & Local-First Engineering Tools';
    } else if (tags.some((t) => ['agency', 'solofounder', 'clientonboarding'].includes(t))) {
      topic = 'Lean Agency Operations & Client Systems';
    } else if (tags.length > 0) {
      topic = `Topic Cluster: #${tags.slice(0, 3).join(', #')}`;
    }

    // 3. Audience problem & Target audience
    let audienceProblem =
      'Audience seeks practical methods to improve workflow efficiency and reduce repetitive manual work.';
    if (lowerText.includes('copy-pasting') || lowerText.includes('waste') || lowerText.includes('hours')) {
      audienceProblem =
        'Losing hours every week to manual copy-pasting and repetitive status updates across disconnected tools.';
    } else if (lowerText.includes('saas') || lowerText.includes('$') || lowerText.includes('cost')) {
      audienceProblem =
        'High recurring SaaS subscription bloat for simple tasks that can be automated with a single workflow.';
    } else if (lowerText.includes('fail') || lowerText.includes('benchmark')) {
      audienceProblem =
        'Lack of reliable benchmarks and deterministic validation when deploying local or production AI models.';
    }

    const targetAudience =
      tags.includes('agency') || tags.includes('solofounder')
        ? 'Solo founders, lean agency operators, and technical builders'
        : 'Developers, AI workflow builders, and productivity-focused operators';

    // 4. Narrative structure
    const narrativeStructure =
      lowerText.includes('stop') || lowerText.includes('why')
        ? [
            'Contrarian / Pain-Point Callout ("Stop doing X manually")',
            'Quantified Time or Cost Stake (hours saved / dollars saved)',
            'Step-by-Step System Walkthrough',
            'Keyword-Gated Lead Magnet CTA',
          ]
        : [
            'Specific Problem Framing',
            'Concrete Demonstration / Benchmark Breakdown',
            'Actionable Takeaway & Save/Comment Prompt',
          ];

    // 5. Emotional trigger
    const emotionalTrigger =
      lowerText.includes('save') || lowerText.includes('replace') || lowerText.includes('stop')
        ? 'Relief from operational friction combined with high perceived utility (concrete time/money savings).'
        : 'Curiosity and professional competence through transparent technical proof.';

    // 6. Call To Action (CTA)
    let callToAction = 'none';
    const commentMatch = combinedText.match(/comment\s+['"]?([A-Za-z0-9_-]+)['"]?/i);
    if (commentMatch) {
      callToAction = `ManyChat/Keyword Comment Trigger: Comment "${commentMatch[1]!.toUpperCase()}" for resource delivery`;
      evidence.push(`Detected explicit comment keyword CTA ("${commentMatch[1]!.toUpperCase()}").`);
    } else if (lowerText.includes('save this')) {
      callToAction = 'Bookmark/Save prompt ("Save this before your next renewal")';
      evidence.push('Detected explicit save prompt in caption.');
    }

    // 7. Editing observations (strictly bounded by available evidence!)
    const editingObservations: string[] = [];
    if (input.durationSeconds !== null) {
      editingObservations.push(
        `Concise runtime of ${input.durationSeconds}s tailored for high completion rate.`
      );
      if (transcript) {
        const wordCount = transcript.split(/\s+/).filter(Boolean).length;
        const wpm = Math.round((wordCount / input.durationSeconds) * 60);
        editingObservations.push(
          `Measured speaking cadence of ~${wpm} words/minute across ${input.durationSeconds}s.`
        );
      }
    }
    if (input.visualDescription) {
      editingObservations.push(`Visual notes: ${input.visualDescription}`);
    }

    // 8. Reusable Content Pattern
    const contentPattern =
      commentMatch !== null
        ? 'Quantified Pain-Point Hook -> 3-Step System Proof -> Keyword Comment Blueprint Delivery'
        : 'Specific Operational Audit / Benchmark -> Transparent Numbers -> Bookmarkable Reference';

    if (input.outlierRatio !== null && input.baselineViews !== null) {
      evidence.push(
        `Achieved ${input.outlierRatio.toFixed(2)}x creator median baseline (${
          input.views?.toLocaleString() ?? 'N/A'
        } views vs ${input.baselineViews.toLocaleString()} baseline) on ${input.canonicalUrl}.`
      );
    }

    // Confidence calculation based on evidence completeness
    let confidence = 0.45;
    if (transcript) confidence += 0.3;
    if (caption) confidence += 0.15;
    if (input.views !== null && input.outlierRatio !== null) confidence += 0.1;
    confidence = Number(Math.min(0.95, confidence).toFixed(2));

    const result: ReelAnalysisOutput = {
      hook,
      topic,
      audienceProblem,
      targetAudience,
      narrativeStructure,
      emotionalTrigger,
      callToAction,
      editingObservations,
      contentPattern,
      evidence,
      limitations,
      confidence,
    };

    return ReelAnalysisOutputSchema.parse(result);
  }

  private async analyzeWithOpenAI(input: ContentAnalysisInput): Promise<ReelAnalysisOutput> {
    const fetchFn = this.options.fetchImpl ?? fetch;
    const systemPrompt = `You are an evidence-backed short-form video research analyst.
Analyze the provided Instagram Reel metadata and return ONLY valid JSON matching this exact schema:
{
  "hook": "Opening hook or unknown",
  "topic": "Main subject",
  "audienceProblem": "Problem being addressed",
  "targetAudience": "Likely audience",
  "narrativeStructure": ["Opening", "Development", "Payoff"],
  "emotionalTrigger": "Evidence-backed interpretation",
  "callToAction": "Detected CTA or none",
  "editingObservations": [],
  "contentPattern": "Reusable high-level pattern",
  "evidence": [],
  "limitations": [],
  "confidence": 0.0
}
CRITICAL RULES:
1. Treat missing transcripts or video access explicitly in "limitations".
2. NEVER infer detailed visual editing, facial expressions, or scene changes from captions alone.
3. Do NOT copy a creator's entire script. Extract general patterns.`;

    const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(input) },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API returned status ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawJson = data.choices?.[0]?.message?.content;
    if (!rawJson) {
      throw new Error('OpenAI response did not contain message content');
    }

    const parsed = JSON.parse(rawJson);
    return ReelAnalysisOutputSchema.parse(parsed);
  }
}
