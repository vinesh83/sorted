import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';

const OPUS_MODEL = 'claude-opus-4-0-20250514';

// Cost tracking for Opus
const OPUS_INPUT_COST_PER_M = 15.0;
const OPUS_OUTPUT_COST_PER_M = 75.0;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

interface CorrectionRow {
  id: number;
  document_id: number;
  field_name: string;
  ai_value: string | null;
  paralegal_value: string | null;
  paralegal_name: string | null;
  file_name: string | null;
  created_at: string;
}

interface RulesRow {
  id: number;
  version: number;
  rules_text: string;
  opus_reasoning: string;
  corrections_analyzed: number;
  accuracy_before: number | null;
  created_at: string;
  active: number;
}

/**
 * Get the current active rules (if any).
 */
export function getActiveRules(): RulesRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM classification_rules WHERE active = 1 ORDER BY version DESC LIMIT 1').get() as RulesRow | undefined) ?? null;
}

/**
 * Get count of corrections since the last Opus analysis.
 */
export function getCorrectionsSinceLastAnalysis(): number {
  const db = getDb();
  const lastRules = getActiveRules();
  const since = lastRules?.created_at ?? '2000-01-01';
  const result = db.prepare('SELECT COUNT(*) as count FROM corrections WHERE created_at > ?').get(since) as { count: number };
  return result.count;
}

/**
 * Check if enough time has passed since last analysis (24h cooldown).
 */
export function canRunAnalysis(): boolean {
  const lastRules = getActiveRules();
  if (!lastRules) return true;
  const lastTime = new Date(lastRules.created_at).getTime();
  const now = Date.now();
  const hoursSince = (now - lastTime) / (1000 * 60 * 60);
  return hoursSince >= 24;
}

/**
 * Check if auto-trigger conditions are met (10+ corrections, 24h cooldown).
 */
export function shouldAutoTrigger(): boolean {
  return getCorrectionsSinceLastAnalysis() >= 10 && canRunAnalysis();
}

// Concurrency lock to prevent simultaneous Opus analyses
let isOptimizing = false;

/**
 * Run Opus analysis on accumulated corrections and generate new classification rules.
 */
export async function analyzeCorrectionsAndGenerateRules(): Promise<{
  version: number;
  rulesText: string;
  reasoning: string;
  correctionsAnalyzed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}> {
  if (isOptimizing) throw new Error('Opus analysis already in progress');
  isOptimizing = true;

  try {
    return await _runAnalysis();
  } finally {
    isOptimizing = false;
  }
}

async function _runAnalysis(): Promise<{
  version: number;
  rulesText: string;
  reasoning: string;
  correctionsAnalyzed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}> {
  const db = getDb();
  const anthropic = getClient();

  // Get corrections since last analysis
  const lastRules = getActiveRules();
  const since = lastRules?.created_at ?? '2000-01-01';

  const corrections = db.prepare(`
    SELECT c.*, d.extracted_text
    FROM corrections c
    LEFT JOIN documents d ON c.document_id = d.id
    WHERE c.created_at > ?
    ORDER BY c.created_at ASC
  `).all(since) as Array<CorrectionRow & { extracted_text: string | null }>;

  if (corrections.length === 0) {
    throw new Error('No new corrections to analyze');
  }

  // Build correction summary for Opus
  const correctionSummary = corrections.map((c, i) => {
    const textSnippet = c.extracted_text ? c.extracted_text.slice(0, 500) : '(no text available)';
    return `Correction ${i + 1}:
  File: ${c.file_name || 'unknown'}
  Field: ${c.field_name}
  AI classified as: "${c.ai_value || '(empty)'}"
  Paralegal corrected to: "${c.paralegal_value || '(empty)'}"
  Paralegal: ${c.paralegal_name || 'unknown'}
  Document text snippet: ${textSnippet}`;
  }).join('\n\n');

  // Get current rules context
  const currentRulesContext = lastRules
    ? `\nCURRENT ACTIVE RULES (version ${lastRules.version}):\n${lastRules.rules_text}\n`
    : '\nNo rules currently active (first analysis).\n';

  // Accuracy stats
  const totalApproved = (db.prepare("SELECT COUNT(*) as c FROM documents WHERE status = 'approved'").get() as { c: number }).c;
  const totalWithCorrections = (db.prepare('SELECT COUNT(DISTINCT document_id) as c FROM corrections').get() as { c: number }).c;
  const accuracyRate = totalApproved > 0 ? ((totalApproved - totalWithCorrections) / totalApproved * 100).toFixed(1) : 'N/A';

  const systemPrompt = `You are an expert at analyzing classification errors and writing concise, actionable rules to improve an AI document classifier.

The classifier works at an immigration law firm and classifies scanned documents into categories. Paralegals review and correct the AI's classifications before approving.

Your job: analyze the corrections below, identify patterns, and write clear rules that would prevent these errors in the future.

IMPORTANT GUIDELINES:
- Write rules as clear, specific instructions (not vague guidelines)
- Each rule should address a concrete pattern seen in the corrections
- Rules should be concise — one sentence each
- Include the document type/pattern and the correct classification
- If a correction seems like a one-off mistake (not a pattern), skip it
- If multiple corrections point to the same pattern, consolidate into one rule
- Prioritize rules that would have the highest impact (most frequent errors first)
- Consider that paralegals may use slightly different wording — normalize to canonical terms
- Maximum 20 rules (quality over quantity)

OUTPUT FORMAT:
Respond with JSON only:
{
  "rules": [
    "Rule text here — be specific and actionable"
  ],
  "reasoning": "Your analysis of the correction patterns, what you learned, and why you chose these rules",
  "estimated_impact": "High/Medium/Low — how much these rules should improve accuracy"
}`;

  const userMessage = `CLASSIFICATION CORRECTION DATA
${corrections.length} corrections from paralegals since last analysis.
Current accuracy rate: ${accuracyRate}%
${currentRulesContext}
CORRECTIONS:
${correctionSummary}

Analyze these corrections, identify patterns, and generate classification rules.`;

  const response = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cost = (inputTokens / 1_000_000) * OPUS_INPUT_COST_PER_M +
               (outputTokens / 1_000_000) * OPUS_OUTPUT_COST_PER_M;

  // Parse response
  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Opus response type');

  let parsed: { rules: string[]; reasoning: string; estimated_impact: string };
  try {
    let jsonStr = content.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[prompt-optimizer] Failed to parse Opus response:', content.text);
    throw new Error('Opus response was not valid JSON');
  }

  // Build rules text
  const rulesText = parsed.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  // Determine new version
  const newVersion = lastRules ? lastRules.version + 1 : 1;

  // Deactivate old rules + insert new ones in a transaction
  const swapRules = db.transaction(() => {
    db.prepare('UPDATE classification_rules SET active = 0').run();
    db.prepare(`
      INSERT INTO classification_rules (version, rules_text, opus_reasoning, corrections_analyzed, accuracy_before, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      newVersion,
      rulesText,
      `${parsed.reasoning}\n\nEstimated impact: ${parsed.estimated_impact}`,
      corrections.length,
      accuracyRate === 'N/A' ? null : parseFloat(accuracyRate),
    );
  });
  swapRules();

  // Log usage
  db.prepare(`
    INSERT INTO api_usage (document_id, model, input_tokens, output_tokens, cost_usd, request_type)
    VALUES (NULL, ?, ?, ?, ?, 'opus_optimization')
  `).run(OPUS_MODEL, inputTokens, outputTokens, cost);

  console.log(`[prompt-optimizer] Generated v${newVersion} rules from ${corrections.length} corrections. Cost: $${cost.toFixed(4)}`);

  return {
    version: newVersion,
    rulesText,
    reasoning: parsed.reasoning,
    correctionsAnalyzed: corrections.length,
    inputTokens,
    outputTokens,
    cost,
  };
}

/**
 * Get all rules versions for history display.
 */
export function getRulesHistory(): RulesRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM classification_rules ORDER BY version DESC').all() as RulesRow[];
}
