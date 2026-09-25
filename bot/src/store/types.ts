/**
 * Storage ports. Two of them, because they fail independently: Postgres can be
 * up while R2 is unreachable, and the pipeline needs to keep the bill either
 * way.
 */

export interface GroupLink {
  ownerId: string;
  /** Null when the group is known but not yet pointed at a project. */
  projectId: string | null;
}

export interface SavedRawMessage {
  id: string;
}

export interface SaveExpenseInput {
  ownerId: string;
  projectId: string;
  amountMinor: bigint | null;
  spentOn: string | null;
  vendor: string | null;
  description: string | null;
  categoryId: string | null;
  postedByWaId: string | null;
  postedByName: string | null;
  sourceMessageId: string;
  status: 'confirmed' | 'needs_review';
  confidence: number;
  extractionNotes: string | null;
}

export interface SaveFileInput {
  ownerId: string;
  expenseId: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  waMessageId: string;
  senderWaId: string | null;
}

export interface Store {
  /** Which owner and project a group belongs to, or null if unclaimed. */
  findGroup(waGroupId: string): Promise<GroupLink | null>;

  /**
   * Writes the raw message. Returns null when `waMessageId` already exists —
   * the idempotency key that makes reconnection safe.
   */
  saveRawMessage(input: {
    ownerId: string;
    waGroupId: string;
    waMessageId: string;
    senderWaId: string | null;
    senderName: string | null;
    body: string | null;
    hasMedia: boolean;
    receivedAt: Date;
  }): Promise<SavedRawMessage | null>;

  listCategoryNames(ownerId: string): Promise<string[]>;
  resolveCategoryId(ownerId: string, name: string | null): Promise<string | null>;

  saveExpense(input: SaveExpenseInput): Promise<{ id: string }>;
  saveFile(input: SaveFileInput): Promise<void>;

  /**
   * Same amount, same day, same vendor, same project, within the window.
   * Flagged for review rather than discarded: buying cement twice in one day
   * is ordinary, and silently dropping the second one loses a real expense.
   */
  findRecentSimilarExpense(input: {
    projectId: string;
    amountMinor: bigint;
    spentOn: string;
    vendor: string | null;
    withinDays: number;
  }): Promise<boolean>;
}

export interface StoredFile {
  path: string;
  thumbnailPath: string | null;
}

export interface FileStore {
  /** Full quality, no re-encoding. A bill that loses a digit is worthless. */
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}
