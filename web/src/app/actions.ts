'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase';

/**
 * Every action here relies on row-level security for authorization: the client
 * carries the user's session, so an update naming someone else's row simply
 * matches nothing. None of these re-check owner_id in JavaScript, which would
 * be a second, weaker copy of the rule.
 */

export async function updateExpense(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const rupees = Number(formData.get('amount'));
  const categoryId = String(formData.get('category_id') ?? '');

  const patch: Record<string, unknown> = {
    vendor: String(formData.get('vendor') ?? '').trim() || null,
    description: String(formData.get('description') ?? '').trim() || null,
    spent_on: String(formData.get('spent_on') ?? '') || null,
    category_id: categoryId || null,
  };

  // An owner correcting the figure is the whole point of the review queue, so
  // this must accept what they type — but not a negative or a nonsense one.
  if (Number.isFinite(rupees) && rupees > 0) {
    patch.amount_minor = Math.round(rupees * 100);
  }

  const supabase = await supabaseServer();
  await supabase.from('expenses').update(patch).eq('id', id);
  revalidatePath(`/expenses/${id}`);
}

export async function confirmExpense(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const supabase = await supabaseServer();
  await supabase.from('expenses').update({ status: 'confirmed' }).eq('id', id);
  revalidatePath('/review');
  revalidatePath(`/expenses/${id}`);
}

export async function deleteExpense(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const supabase = await supabaseServer();
  // Soft delete: the link to the original bill survives, which matters when a
  // deletion turns out to have been a mistake.
  await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  revalidatePath('/review');
  revalidatePath('/');
}

export async function createProject(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return;
  await supabase.from('projects').insert({ owner_id: data.user.id, name });
  revalidatePath('/settings');
  revalidatePath('/');
}

export async function createCategory(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return;
  await supabase.from('categories').insert({ owner_id: data.user.id, name });
  revalidatePath('/settings');
}

export async function linkGroup(formData: FormData): Promise<void> {
  const groupId = String(formData.get('group_id'));
  const projectId = String(formData.get('project_id') ?? '');
  const supabase = await supabaseServer();
  await supabase
    .from('whatsapp_groups')
    .update({ project_id: projectId || null, linked_at: projectId ? new Date().toISOString() : null })
    .eq('id', groupId);
  revalidatePath('/settings');
}
