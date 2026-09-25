import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { GroupLink, SaveExpenseInput, SaveFileInput, SavedRawMessage, Store } from './types.ts';

/**
 * The bot's database adapter. It holds the SERVICE ROLE key and therefore
 * bypasses row-level security completely, which is why every method here
 * takes an explicit ownerId and never derives one from message content.
 */
export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async findGroup(waGroupId: string): Promise<GroupLink | null> {
    const { data } = await this.db
      .from('whatsapp_groups')
      .select('owner_id, project_id')
      .eq('wa_group_id', waGroupId)
      .maybeSingle();
    if (!data) return null;
    return { ownerId: data.owner_id, projectId: data.project_id };
  }

  async saveRawMessage(input: {
    ownerId: string; waGroupId: string; waMessageId: string;
    senderWaId: string | null; senderName: string | null;
    body: string | null; hasMedia: boolean; receivedAt: Date;
  }): Promise<SavedRawMessage | null> {
    const { data, error } = await this.db
      .from('raw_messages')
      .insert({
        owner_id: input.ownerId,
        wa_group_id: input.waGroupId,
        wa_message_id: input.waMessageId,
        sender_wa_id: input.senderWaId,
        sender_name: input.senderName,
        body: input.body,
        has_media: input.hasMedia,
        received_at: input.receivedAt.toISOString(),
      })
      .select('id')
      .single();

    // 23505 is the unique violation on wa_message_id: we have seen this
    // message. That is the dedupe, and it is why reconnection is safe.
    if (error) {
      if (error.code === '23505') return null;
      throw new Error(`saveRawMessage: ${error.message}`);
    }
    return { id: data.id };
  }

  async listCategoryNames(ownerId: string): Promise<string[]> {
    const { data } = await this.db.from('categories').select('name').eq('owner_id', ownerId);
    return (data ?? []).map((r) => r.name as string);
  }

  async resolveCategoryId(ownerId: string, name: string | null): Promise<string | null> {
    if (!name) return null;
    const { data } = await this.db
      .from('categories')
      .select('id')
      .eq('owner_id', ownerId)
      .ilike('name', name)
      .maybeSingle();
    return data?.id ?? null;
  }

  async saveExpense(input: SaveExpenseInput): Promise<{ id: string }> {
    const { data, error } = await this.db
      .from('expenses')
      .insert({
        owner_id: input.ownerId,
        project_id: input.projectId,
        // bigint over the wire as a string: a JS number cannot hold large
        // paise values without losing precision.
        amount_minor: input.amountMinor === null ? null : input.amountMinor.toString(),
        spent_on: input.spentOn,
        vendor: input.vendor,
        description: input.description,
        category_id: input.categoryId,
        posted_by_wa_id: input.postedByWaId,
        posted_by_name: input.postedByName,
        source_message_id: input.sourceMessageId,
        status: input.status,
        confidence: input.confidence,
        extraction_notes: input.extractionNotes,
      })
      .select('id')
      .single();
    if (error) throw new Error(`saveExpense: ${error.message}`);
    return { id: data.id };
  }

  async saveFile(input: SaveFileInput): Promise<void> {
    const { error } = await this.db.from('expense_files').insert({
      owner_id: input.ownerId,
      expense_id: input.expenseId,
      storage_path: input.storagePath,
      thumbnail_path: input.thumbnailPath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      wa_message_id: input.waMessageId,
      sender_wa_id: input.senderWaId,
    });
    if (error) throw new Error(`saveFile: ${error.message}`);
  }

  async findRecentSimilarExpense(input: {
    projectId: string; amountMinor: bigint; spentOn: string;
    vendor: string | null; withinDays: number;
  }): Promise<boolean> {
    const since = new Date(Date.parse(input.spentOn) - input.withinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    let query = this.db
      .from('expenses')
      .select('id')
      .eq('project_id', input.projectId)
      .eq('amount_minor', input.amountMinor.toString())
      .gte('spent_on', since)
      .lte('spent_on', input.spentOn)
      .is('deleted_at', null)
      .limit(1);

    if (input.vendor) query = query.ilike('vendor', input.vendor);

    const { data } = await query;
    return (data ?? []).length > 0;
  }
}
