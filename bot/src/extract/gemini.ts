import type { Extraction, ExtractionInput, Extractor } from './types.ts';

/**
 * Gemini via plain fetch. No SDK: this is one HTTP call with a JSON schema,
 * and a client library for that is a dependency to keep current for no gain.
 *
 * WARNING — the FREE tier may use prompts and responses to improve Google's
 * products, including human review. This sends photographs of customers'
 * bills: vendor names, amounts, phone numbers, sometimes GSTINs. Use a paid
 * key before onboarding a real customer. See docs/p0-tech-design.md §2.3.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const EXTRACTION_SCHEMA = {
  type: 'object',
  required: ['is_expense', 'confidence'],
  properties: {
    is_expense: { type: 'boolean' },
    confidence: { type: 'number' },
    amount_rupees: { type: 'number', nullable: true },
    date: { type: 'string', nullable: true },
    vendor: { type: 'string', nullable: true },
    description: { type: 'string', nullable: true },
    category: { type: 'string', nullable: true },
    language: { type: 'string', enum: ['en', 'te', 'mixed'] },
    notes: { type: 'string', nullable: true },
  },
} as const;

export function buildPrompt(input: ExtractionInput): string {
  return `You extract expense records from messages in a WhatsApp group used by a
small business in South India. Messages may be English, Telugu, or both
mixed in one message. Bills may be handwritten, blurry, or photographed at
an angle.

Decide first whether this message records money the business SPENT.

NOT expenses: greetings, planning, questions, "I will pay tomorrow",
photos of work or materials with no amount, forwarded promotions,
payment requests that have not been paid yet.

ARE expenses: a bill or invoice image, a payment screenshot, or text
stating an amount that was paid.

If it is an expense, extract:
- amount: the TOTAL paid, in rupees. If the bill shows a grand total and
  line items, take the grand total. Never sum the items yourself.
- date: when the money was spent (the bill date, not today) as YYYY-MM-DD.
  If absent, use the message date supplied below.
- vendor: who was paid. Shop name if visible, else the person's name.
- description: a short phrase in English, under 60 characters.
- category: exactly one of the provided list, else "Other".

Rules:
- Return null for anything you cannot read. Never guess a number.
- Confidence must reflect the amount specifically. A clear printed total
  is high; a smudged handwritten figure is low even if everything else is
  legible.
- Telugu amounts in words ("రెండు వేలు" = 2000) should be converted.

Message date: ${input.messageDate}
Sender: ${input.senderName ?? 'unknown'}
Available categories: ${input.categories.join(', ')}
Message text: ${input.text ?? '(no text)'}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Whatever the model returns, coerced into something the pipeline can trust. */
export function parseExtraction(raw: unknown): Extraction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  const confidence = num(o.confidence);
  const language = o.language === 'te' || o.language === 'mixed' ? o.language : 'en';

  return {
    isExpense: o.is_expense === true,
    // An absent or nonsense confidence is treated as zero, which sends the
    // item to review. Never assume the model was sure.
    confidence: confidence === null ? 0 : Math.min(1, Math.max(0, confidence)),
    amountRupees: num(o.amount_rupees),
    date: str(o.date),
    vendor: str(o.vendor),
    description: str(o.description),
    category: str(o.category),
    language,
    notes: str(o.notes),
  };
}

export class GeminiExtractor implements Extractor {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gemini-2.5-flash',
    private readonly timeoutMs = 30_000,
  ) {}

  async extract(input: ExtractionInput): Promise<Extraction> {
    const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(input) }];
    if (input.media) {
      parts.push({
        inline_data: { mime_type: input.media.mimeType, data: toBase64(input.media.bytes) },
      });
    }

    const response = await fetch(`${ENDPOINT}/${this.model}:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA,
          temperature: 0,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('gemini returned no content');

    return parseExtraction(JSON.parse(text));
  }
}
