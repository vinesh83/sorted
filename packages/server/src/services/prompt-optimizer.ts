import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { getCached, putCache } from './filecache.js';
import { downloadFile } from './dropbox.js';
import { convertPdfToImages } from './pdf-utils.js';
import { buildDocumentLabelGuidance } from './asana-form-vocabulary.js';

const ANALYSIS_MODEL = 'claude-sonnet-4-6';

// Sonnet pricing per 1M tokens
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

// Max unique documents to include images for (cost control)
const MAX_VISION_DOCUMENTS = 10;

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

interface CorrectionWithContext extends CorrectionRow {
  extracted_text: string | null;
  dropbox_path: string | null;
  pf_id: number | null;
  mime_type: string | null;
}

interface RulesRow {
  id: number;
  version: number;
  rules_text: string;
  model_reasoning: string;
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
 * Get count of corrections since the last analysis.
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

// Concurrency lock to prevent simultaneous analyses
let isOptimizing = false;

/**
 * Run Sonnet analysis on accumulated corrections and generate new classification rules.
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
  if (isOptimizing) throw new Error('Analysis already in progress');
  isOptimizing = true;

  try {
    return await _runAnalysis();
  } finally {
    isOptimizing = false;
  }
}

/**
 * Fetch page 1 image for a document. Returns base64 + media type, or null on failure.
 */
async function getDocumentImage(
  pfId: number,
  dropboxPath: string,
  mimeType: string | null,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    // Try local cache first, then Dropbox
    let buffer = getCached(pfId);
    if (!buffer) {
      buffer = await downloadFile(dropboxPath);
      putCache(pfId, buffer);
    }

    if (mimeType === 'application/pdf') {
      const images = await convertPdfToImages(buffer, { firstPage: 1, lastPage: 1 });
      if (images.length === 0) return null;
      return { base64: images[0].toString('base64'), mediaType: 'image/jpeg' };
    } else if (mimeType?.startsWith('image/')) {
      const mediaType = mimeType === 'image/png' ? 'image/png'
        : mimeType === 'image/webp' ? 'image/webp'
        : 'image/jpeg';
      return { base64: buffer.toString('base64'), mediaType };
    }

    return null; // DOCX/DOC/other — no image
  } catch (err) {
    console.warn(`[prompt-optimizer] Failed to get image for pf_id=${pfId}:`, err instanceof Error ? err.message : err);
    return null;
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

  // Get corrections since last analysis, joined with file paths
  const lastRules = getActiveRules();
  const since = lastRules?.created_at ?? '2000-01-01';

  const corrections = db.prepare(`
    SELECT c.*, d.extracted_text, pf.dropbox_path, pf.id as pf_id, pf.mime_type
    FROM corrections c
    LEFT JOIN documents d ON c.document_id = d.id
    LEFT JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE c.created_at > ?
    ORDER BY c.created_at ASC
  `).all(since) as CorrectionWithContext[];

  if (corrections.length === 0) {
    throw new Error('No new corrections to analyze');
  }

  // Fetch document images, deduplicated by pf_id, capped at MAX_VISION_DOCUMENTS
  // Prioritize: documents with no OCR text first, then by correction count
  const pfCounts = new Map<number, { count: number; hasText: boolean; correction: CorrectionWithContext }>();
  for (const c of corrections) {
    if (!c.pf_id || !c.dropbox_path) continue;
    const existing = pfCounts.get(c.pf_id);
    if (existing) {
      existing.count++;
    } else {
      pfCounts.set(c.pf_id, { count: 1, hasText: !!c.extracted_text, correction: c });
    }
  }

  // Sort: no-text docs first, then by correction count descending
  const sortedPfs = [...pfCounts.entries()]
    .sort(([, a], [, b]) => {
      if (a.hasText !== b.hasText) return a.hasText ? 1 : -1;
      return b.count - a.count;
    })
    .slice(0, MAX_VISION_DOCUMENTS);

  // Fetch images sequentially to avoid Dropbox rate limits
  const imageMap = new Map<number, { base64: string; mediaType: string }>();
  for (const [pfId, { correction: c }] of sortedPfs) {
    const image = await getDocumentImage(pfId, c.dropbox_path!, c.mime_type);
    if (image) {
      imageMap.set(pfId, image);
    }
  }

  console.log(`[prompt-optimizer] Fetched ${imageMap.size} document images for ${corrections.length} corrections`);

  // Get current rules context
  const currentRulesContext = lastRules
    ? `\nCURRENT ACTIVE RULES (version ${lastRules.version}):\n${lastRules.rules_text}\n`
    : '\nNo rules currently active (first analysis).\n';

  // Accuracy stats
  const totalApproved = (db.prepare("SELECT COUNT(*) as c FROM documents WHERE status IN ('approved', 'sorted')").get() as { c: number }).c;
  const totalWithCorrections = (db.prepare('SELECT COUNT(DISTINCT document_id) as c FROM corrections').get() as { c: number }).c;
  const accuracyRate = totalApproved > 0 ? ((totalApproved - totalWithCorrections) / totalApproved * 100).toFixed(1) : 'N/A';

  const systemPrompt = `You are an expert at analyzing classification errors and writing concise, actionable rules to improve an AI document classifier.

The classifier works at an immigration law firm and classifies scanned documents into categories. Paralegals review and correct the AI's classifications before approving.

Your job: analyze the corrections below, identify patterns, and write clear rules that would prevent these errors in the future.

For each correction, you may see an image of the actual document page. Use the visual content (headers, logos, form numbers, stamps, checkboxes, layout) alongside the text metadata to understand what kind of document was misclassified and why the paralegal's correction is appropriate.

IMPORTANT GUIDELINES:
- Write rules as clear, specific instructions (not vague guidelines)
- Each rule should address a concrete pattern seen in the corrections
- Rules should be concise — one sentence each
- Include the document type/pattern and the correct classification
- Reference visual indicators when relevant (e.g., "Documents with USCIS header and form number I-797C should be classified as...")
- If a correction seems like a one-off mistake (not a pattern), skip it
- If multiple corrections point to the same pattern, consolidate into one rule
- Prioritize rules that would have the highest impact (most frequent errors first)
- Consider that paralegals may use slightly different wording — normalize to canonical terms
- The firm uses specific naming conventions for document labels. Here is the full guide that the classifier uses:
${buildDocumentLabelGuidance()}
When generating rules, align corrections toward these canonical label formats.
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

  // Build multi-modal content array
  const contentBlocks: Anthropic.ContentBlockParam[] = [];

  contentBlocks.push({
    type: 'text',
    text: `CLASSIFICATION CORRECTION DATA
${corrections.length} corrections from paralegals since last analysis.
Current accuracy rate: ${accuracyRate}%
${currentRulesContext}
CORRECTIONS:`,
  });

  for (let i = 0; i < corrections.length; i++) {
    const c = corrections[i];
    const image = c.pf_id ? imageMap.get(c.pf_id) : null;

    // Add document image if available
    if (image) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.base64,
        },
      });
    }

    const textSnippet = c.extracted_text ? c.extracted_text.slice(0, 500) : '(no text available)';
    contentBlocks.push({
      type: 'text',
      text: `Correction ${i + 1}:
  File: ${c.file_name || 'unknown'}
  Field: ${c.field_name}
  AI classified as: "${c.ai_value || '(empty)'}"
  Paralegal corrected to: "${c.paralegal_value || '(empty)'}"
  Paralegal: ${c.paralegal_name || 'unknown'}
  ${image ? '(document image shown above)' : `Document text snippet: ${textSnippet}`}`,
    });
  }

  contentBlocks.push({
    type: 'text',
    text: 'Analyze these corrections, identify patterns, and generate classification rules.',
  });

  const response = await anthropic.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cost = (inputTokens / 1_000_000) * INPUT_COST_PER_M +
               (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;

  // Parse response
  if (!response.content.length) {
    throw new Error('Empty response from Sonnet (no content blocks returned)');
  }
  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type');

  let parsed: { rules: string[]; reasoning: string; estimated_impact: string };
  try {
    let jsonStr = content.text.trim();
    if (jsonStr.match(/^[\s]*```/)) {
      jsonStr = jsonStr.replace(/^[\s]*```\w*\s*\n?/, '').replace(/\n?\s*```[\s]*$/, '');
    }
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[prompt-optimizer] Failed to parse response:', content.text.slice(0, 500));
    throw new Error('Analysis response was not valid JSON');
  }

  if (!Array.isArray(parsed.rules)) {
    throw new Error(`Expected "rules" to be an array, got: ${typeof parsed.rules}`);
  }

  // Build rules text
  const rulesText = parsed.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  // Determine new version
  const newVersion = lastRules ? lastRules.version + 1 : 1;

  // Deactivate old rules + insert new ones in a transaction
  const swapRules = db.transaction(() => {
    db.prepare('UPDATE classification_rules SET active = 0').run();
    db.prepare(`
      INSERT INTO classification_rules (version, rules_text, model_reasoning, corrections_analyzed, accuracy_before, active)
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
    VALUES (NULL, ?, ?, ?, ?, 'sonnet_optimization')
  `).run(ANALYSIS_MODEL, inputTokens, outputTokens, cost);

  console.log(`[prompt-optimizer] Generated v${newVersion} rules from ${corrections.length} corrections (${imageMap.size} with images). Cost: $${cost.toFixed(4)}`);

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
