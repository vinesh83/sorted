import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import type { ClassificationResult, EventType } from 'shared/types.js';
import { EVENT_TYPES } from 'shared/types.js';
import { getActiveRules } from './prompt-optimizer.js';
import { buildDocumentLabelGuidance } from './asana-form-vocabulary.js';

const MODEL = 'claude-haiku-4-5-20251001';

// Haiku pricing per 1M tokens (as of 2025)
const INPUT_COST_PER_M = 1.0; // $1.00 per 1M input tokens
const OUTPUT_COST_PER_M = 5.0; // $5.00 per 1M output tokens

const MAX_IMAGE_PAGES = 20;

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const SYSTEM_PROMPT = `You are a document classifier for an immigration law firm (vpatellaw.com). You will be shown document page images and/or extracted text. Use both the visual content (headers, logos, form numbers, stamps, layout) and any extracted text to classify the document.

Classify with the following fields:

1. documentLabel: A short label for the document type, following the DOCUMENT LABEL FORMAT GUIDE below. Use exact terminology from the guide when the document matches a known type. For unrecognized documents, infer the label a paralegal would use based on the same naming conventions.
2. clientName: The client's name if identifiable, in "Last, First" format. Look for the respondent/applicant/beneficiary name, not the attorney or government official.
3. description: A one-line description suitable as an Asana task name (e.g., "Bond Hearing Notice for I-42B application")
4. eventType: One of: ${EVENT_TYPES.join(', ')}
   - "Received" = document received from a government agency (USCIS, EOIR, court)
   - "Sent/Filed" = document sent/filed by the firm
   - "Supporting Doc(s)" = client-provided supporting documents (birth certs, IDs, proof of income, etc.)
   - "Criminal Records" = criminal record checks, rap sheets, court records
   - "Physical Document" = original physical documents scanned in
   - "Note/Strategy" = internal notes or strategy memos
   - "Action" = something that requires follow-up action
5. suggestedSection: Based on eventType:
   - Received or Sent/Filed → "Filings and Official Correspondence"
   - Supporting Doc(s) or Physical Document → "Client Supporting Documents"
   - Criminal Records → "Criminal Records/Requests"
   - Note/Strategy or Action → null
6. documentDate: The most relevant date on the document (issue date, receipt date, or filing date) in YYYY-MM-DD format. If no date found, return null.
7. confidence: 0.0 to 1.0 how confident you are in the overall classification
8. isLegalDocument: true if this is a legal/immigration document, false if it's a random file (screenshot, temp file, etc.)
9. isMultipleDocuments: true if the text appears to contain multiple distinct documents combined into one file
10. suggestedSplits: If isMultipleDocuments is true, an array of {pageStart, pageEnd, reason} identifying where each document begins and ends
11. reasoning: Brief explanation of your classification

${buildDocumentLabelGuidance()}

Respond with ONLY valid JSON, no markdown or explanation outside the JSON.`;

function resolveMediaType(mimeType?: string): ImageMediaType {
  if (mimeType === 'image/png') return 'image/png';
  if (mimeType === 'image/gif') return 'image/gif';
  if (mimeType === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Classify a document using page images and/or extracted text.
 * When page images are provided, they are sent as vision content alongside text.
 * When no images are available (e.g., DOCX), falls back to text-only classification.
 */
export async function classifyDocument(
  pageImages: Buffer[],
  ocrText: string,
  fileName: string,
  imageMimeType?: string,
): Promise<{ classification: ClassificationResult; inputTokens: number; outputTokens: number }> {
  const anthropic = getClient();

  // Build system prompt with any active learned rules
  let systemPrompt = SYSTEM_PROMPT;
  try {
    const activeRules = getActiveRules();
    if (activeRules?.rules_text) {
      systemPrompt += `\n\nLEARNED RULES (from paralegal feedback — follow these strictly):\n${activeRules.rules_text}`;
    }
  } catch {
    // If rules lookup fails, use base prompt
  }

  const hasImages = pageImages.length > 0;
  const mediaType = resolveMediaType(imageMimeType);

  let content: Anthropic.MessageCreateParams['messages'][0]['content'];

  if (hasImages) {
    // Vision + text: send page images followed by text context
    const imagesToSend = pageImages.slice(0, MAX_IMAGE_PAGES);
    const contentBlocks: Anthropic.ContentBlockParam[] = [];

    for (const img of imagesToSend) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: img.toString('base64') },
      });
    }

    let textContext = `File name: ${fileName}`;
    if (pageImages.length > MAX_IMAGE_PAGES) {
      textContext += `\n\nNote: This document has ${pageImages.length} pages. Showing first ${MAX_IMAGE_PAGES} page images above.`;
    }
    if (ocrText) {
      textContext += `\n\nExtracted text (supplementary):\n${ocrText}`;
    }
    textContext += '\n\nClassify this document based on the page images and any extracted text above.';

    contentBlocks.push({ type: 'text', text: textContext });
    content = contentBlocks;
  } else {
    // Text-only fallback (DOCX, DOC, or when image conversion failed)
    content = `File name: ${fileName}\n\nExtracted text:\n${ocrText}`;
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  if (!response.content.length) {
    throw new Error('Empty response from Claude (no content blocks returned)');
  }

  const responseContent = response.content[0];
  if (responseContent.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  let classification: ClassificationResult;
  try {
    let jsonStr = responseContent.text.trim();
    if (jsonStr.match(/^[\s]*```/)) {
      jsonStr = jsonStr.replace(/^[\s]*```\w*\s*\n?/, '').replace(/\n?\s*```[\s]*$/, '');
    }
    classification = JSON.parse(jsonStr);
  } catch (err) {
    console.error('[classifier] Failed to parse response:', responseContent.text);
    throw new Error(`Classification response was not valid JSON: ${err}`);
  }

  // Validate required fields exist
  if (!classification.documentLabel || typeof classification.documentLabel !== 'string') {
    throw new Error(`Classification missing required field "documentLabel": ${JSON.stringify(classification)}`);
  }
  if (typeof classification.confidence !== 'number') {
    throw new Error(`Classification missing required field "confidence": ${JSON.stringify(classification)}`);
  }

  if (!EVENT_TYPES.includes(classification.eventType as EventType)) {
    console.warn(`[classifier] Invalid eventType "${classification.eventType}", defaulting to "Received"`);
    classification.eventType = 'Received';
  }

  return { classification, inputTokens, outputTokens };
}

export function logUsage(
  documentId: number | null,
  inputTokens: number,
  outputTokens: number,
  requestType: string,
) {
  const cost =
    (inputTokens / 1_000_000) * INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;

  const db = getDb();
  db.prepare(`
    INSERT INTO api_usage (document_id, model, input_tokens, output_tokens, cost_usd, request_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(documentId, MODEL, inputTokens, outputTokens, cost, requestType);

  console.log(
    `[classifier] Usage: ${inputTokens} in / ${outputTokens} out = $${cost.toFixed(4)} (${requestType})`,
  );
}
