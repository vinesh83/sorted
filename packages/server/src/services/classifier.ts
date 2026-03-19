import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import type { ClassificationResult, EventType } from 'shared/types.js';
import { EVENT_TYPES } from 'shared/types.js';
import { getActiveRules } from './prompt-optimizer.js';

const MODEL = 'claude-haiku-4-5-20251001';

// Haiku pricing per 1M tokens (as of 2025)
const INPUT_COST_PER_M = 1.0; // $1.00 per 1M input tokens
const OUTPUT_COST_PER_M = 5.0; // $5.00 per 1M output tokens

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const SYSTEM_PROMPT = `You are a document classifier for an immigration law firm (vpatellaw.com). Given the extracted text from a scanned document, classify it with the following fields:

1. documentLabel: A short descriptive label for the document type (e.g., "Bond Hearing Notice", "I-130 Petition", "Birth Certificate", "Proof of Income", "I-94 Record", "Client ID", "EOIR Notice", "EAD Card")
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

Respond with ONLY valid JSON, no markdown or explanation outside the JSON.`;

/**
 * Classify a document using extracted text.
 */
export async function classifyDocument(
  extractedText: string,
  fileName: string,
): Promise<{ classification: ClassificationResult; inputTokens: number; outputTokens: number }> {
  const anthropic = getClient();

  const userMessage = `File name: ${fileName}\n\nExtracted text:\n${extractedText.slice(0, 16000)}`;

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

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  // Extract text from response
  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Parse JSON from response
  let classification: ClassificationResult;
  try {
    // Try to extract JSON from the response (handle potential markdown wrapping)
    let jsonStr = content.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    classification = JSON.parse(jsonStr);
  } catch (err) {
    console.error('[classifier] Failed to parse response:', content.text);
    throw new Error(`Classification response was not valid JSON: ${err}`);
  }

  // Validate eventType
  if (!EVENT_TYPES.includes(classification.eventType as EventType)) {
    console.warn(`[classifier] Invalid eventType "${classification.eventType}", defaulting to "Received"`);
    classification.eventType = 'Received';
  }

  return { classification, inputTokens, outputTokens };
}

/**
 * Classify a document using vision (image of the document).
 * Used as fallback when OCR fails or returns no text.
 */
export async function classifyDocumentVision(
  imageBuffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<{ classification: ClassificationResult; inputTokens: number; outputTokens: number }> {
  const anthropic = getClient();

  // Convert buffer to base64
  const base64 = imageBuffer.toString('base64');
  const mediaType = (
    mimeType === 'image/png' ? 'image/png' :
    mimeType === 'image/gif' ? 'image/gif' :
    mimeType === 'image/webp' ? 'image/webp' :
    'image/jpeg'
  ) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

  // Build system prompt with any active learned rules
  let visionSystemPrompt = SYSTEM_PROMPT;
  try {
    const activeRules = getActiveRules();
    if (activeRules?.rules_text) {
      visionSystemPrompt += `\n\nLEARNED RULES (from paralegal feedback — follow these strictly):\n${activeRules.rules_text}`;
    }
  } catch {
    // If rules lookup fails, use base prompt
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: visionSystemPrompt,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `File name: ${fileName}\n\nPlease classify this document image. The OCR failed so you are looking at the raw image. Extract what you can see and classify it.`,
        },
      ],
    }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  let classification: ClassificationResult;
  try {
    let jsonStr = content.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    classification = JSON.parse(jsonStr);
  } catch (err) {
    console.error('[classifier] Failed to parse vision response:', content.text);
    throw new Error(`Vision classification response was not valid JSON: ${err}`);
  }

  if (!EVENT_TYPES.includes(classification.eventType as EventType)) {
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
