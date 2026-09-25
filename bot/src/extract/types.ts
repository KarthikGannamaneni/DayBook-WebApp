/**
 * The seam between the pipeline and the model, so the pipeline can be tested
 * without a network call or an API key.
 */

export interface ExtractionInput {
  text: string | null;
  media: { mimeType: string; bytes: Uint8Array } | null;
  /** The message's own date, used when the bill shows none. */
  messageDate: string;
  senderName: string | null;
  categories: string[];
}

export interface Extraction {
  isExpense: boolean;
  /** 0–1, and about the AMOUNT specifically. See the prompt. */
  confidence: number;
  amountRupees: number | null;
  date: string | null;
  vendor: string | null;
  description: string | null;
  category: string | null;
  language: 'en' | 'te' | 'mixed';
  /** What was unclear. Shown to the owner in the review queue. */
  notes: string | null;
}

export interface Extractor {
  extract(input: ExtractionInput): Promise<Extraction>;
}
