import type { Extraction, ExtractionInput, Extractor, TxnStatus } from './types.ts';

/**
 * Gemini via plain fetch. No SDK: this is one HTTP call with a JSON schema, and
 * a client library for that is a dependency to keep current for no gain.
 *
 * WARNING — the FREE tier may use prompts and responses to improve Google's
 * products, including human review. Under this product that means sending the
 * BUSINESS'S CUSTOMERS' names, UPI handles, phone numbers and transaction
 * references, which makes the business a data fiduciary for them under the DPDP
 * Act. A paid key is a precondition for the first real customer, not a
 * pre-launch task. See docs/p0-tech-design.md §2.3.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Pinned, not `gemini-flash-latest`. An alias that moves under you is fine for a
 * chatbot and wrong here: the whole point of milestone 4 is measuring extraction
 * accuracy on real documents, and a number measured against a model that has
 * since changed is not a number. Bump it deliberately and re-measure.
 *
 * gemini-2.5-flash, which this originally used, is no longer available to new
 * API keys at all — Google returns 404 with a note pointing at the 3.x line.
 */

export const EXTRACTION_SCHEMA = {
  type: 'object',
  required: ['doc_kind', 'confidence'],
  properties: {
    doc_kind: { type: 'string', enum: ['invoice', 'payment', 'neither'] },
    confidence: { type: 'number' },
    invoice: {
      type: 'object',
      nullable: true,
      properties: {
        customer_name: { type: 'string', nullable: true },
        amount_rupees: { type: 'number', nullable: true },
        invoice_no: { type: 'string', nullable: true },
        issued_on: { type: 'string', nullable: true },
        due_on: { type: 'string', nullable: true },
        description: { type: 'string', nullable: true },
      },
    },
    payment: {
      type: 'object',
      nullable: true,
      properties: {
        payer_name: { type: 'string', nullable: true },
        amount_rupees: { type: 'number', nullable: true },
        paid_on: { type: 'string', nullable: true },
        utr: { type: 'string', nullable: true },
        payer_vpa: { type: 'string', nullable: true },
        payee_vpa: { type: 'string', nullable: true },
        app: { type: 'string', nullable: true },
        txn_status: { type: 'string', enum: ['completed', 'pending', 'failed'] },
        note: { type: 'string', nullable: true },
      },
    },
    language: { type: 'string', enum: ['en', 'te', 'mixed'] },
    notes: { type: 'string', nullable: true },
  },
} as const;

export function buildPrompt(input: ExtractionInput): string {
  return `You read messages from a WhatsApp group used by a small business in South
India to keep its accounts. Staff forward two kinds of document into it:
invoices the business ISSUED to its customers, and screenshots confirming
UPI payments the business RECEIVED. Messages may be English, Telugu, or both
mixed. Invoices may be handwritten, blurry, or photographed at an angle.

Decide first which of three things this message is.

"invoice" — a bill or invoice the business issued: a customer name, an
amount owed, usually an invoice number and a date. A photo of a handwritten
bill book page counts.

"payment" — a confirmation that money was RECEIVED: a GPay / PhonePe /
Paytm / bank screenshot, or a bank credit alert. It shows an amount, who
paid, and a reference number.

"neither" — everything else. Greetings, planning, questions, photos of work
or materials, forwarded promotions, price lists, and — importantly — a
REQUEST for payment that has not been paid ("please pay 5000", a bare QR
code). A request is not a payment.

If it is an invoice, extract:
- customer_name: who owes the money. Shop or company name if visible, else
  the person's name.
- amount_rupees: the grand total. If the bill shows a total and line items,
  take the total. Never sum the items yourself.
- invoice_no: exactly as printed or written, including any prefix.
- issued_on / due_on: YYYY-MM-DD. Use the bill's own date, not today.
- description: a short phrase in English, under 60 characters.

If it is a payment, extract:
- payer_name: the name the app shows for whoever sent the money.
- amount_rupees: the amount transferred.
- paid_on: YYYY-MM-DD from the screenshot, not today.
- utr: the UPI transaction reference / UTR / order id. Usually 12 digits.
- payer_vpa / payee_vpa: the UPI ids (like name@bank), sender and receiver.
- app: which app the screenshot came from, if identifiable.
- txn_status: read it off the screen. "Completed", "Success", "Paid" or a
  green tick means "completed". "Pending", "Processing", "Failed",
  "Declined" mean exactly that. If you cannot see a status, answer
  "pending". NEVER answer "completed" unless the screen says so — a failed
  payment recorded as received puts money in the books that never arrived.
- note: any remark or message attached to the transfer, copied verbatim. It
  sometimes contains an invoice number, which is the single most useful
  thing on the screenshot.

Rules:
- Return null for anything you cannot read. Never guess a number.
- confidence must reflect the AMOUNT specifically. A clear printed total is
  high; a smudged handwritten figure is low even if everything else is
  legible.
- Telugu amounts in words ("రెండు వేలు" = 2000) should be converted.
- Fill only the object for the kind you chose; leave the other null.

Message date: ${input.messageDate}
Sender: ${input.senderName ?? 'unknown'}
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

  const docKind =
    o.doc_kind === 'invoice' || o.doc_kind === 'payment' ? o.doc_kind : 'neither';
  const confidence = num(o.confidence);
  const language = o.language === 'te' || o.language === 'mixed' ? o.language : 'en';

  const inv = (o.invoice ?? {}) as Record<string, unknown>;
  const pay = (o.payment ?? {}) as Record<string, unknown>;

  // Anything other than an explicit success is not money. An unreadable or
  // absent status must never become 'completed'.
  const txnStatus: TxnStatus =
    pay.txn_status === 'completed' ? 'completed' : pay.txn_status === 'failed' ? 'failed' : 'pending';

  return {
    docKind,
    // An absent or nonsense confidence is treated as zero, which sends the item
    // to review. Never assume the model was sure.
    confidence: confidence === null ? 0 : Math.min(1, Math.max(0, confidence)),
    invoice:
      docKind === 'invoice'
        ? {
            customerName: str(inv.customer_name),
            amountRupees: num(inv.amount_rupees),
            invoiceNo: str(inv.invoice_no),
            issuedOn: str(inv.issued_on),
            dueOn: str(inv.due_on),
            description: str(inv.description),
          }
        : null,
    payment:
      docKind === 'payment'
        ? {
            payerName: str(pay.payer_name),
            amountRupees: num(pay.amount_rupees),
            paidOn: str(pay.paid_on),
            utr: str(pay.utr),
            payerVpa: str(pay.payer_vpa),
            payeeVpa: str(pay.payee_vpa),
            app: str(pay.app),
            txnStatus,
            note: str(pay.note),
          }
        : null,
    language,
    notes: str(o.notes),
  };
}

export class GeminiExtractor implements Extractor {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gemini-3.8-flash',
    private readonly timeoutMs = 30_000,
    private readonly attempts = 3,
  ) {}

  async extract(input: ExtractionInput): Promise<Extraction> {
    let lastError: unknown;
    // Retry twice with backoff, as docs §6 specifies. A transient 429 or 503
    // must not send a readable bill to the manual queue.
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await this.callOnce(input);
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async callOnce(input: ExtractionInput): Promise<Extraction> {
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
