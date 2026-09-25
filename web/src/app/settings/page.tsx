import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createCategory, createProject, linkGroup } from '@/app/actions';
import { requireUser, supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export default async function Settings() {
  if (!(await requireUser())) redirect('/sign-in');
  const supabase = await supabaseServer();

  const [{ data: projects }, { data: categories }, { data: groups }] = await Promise.all([
    supabase.from('projects').select('id, name').is('archived_at', null).order('name'),
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('whatsapp_groups').select('id, name, wa_group_id, project_id').order('created_at'),
  ]);

  return (
    <main>
      <nav className="top"><Link href="/">← Projects</Link></nav>
      <h1>Settings</h1>

      <h2>Projects</h2>
      {(projects ?? []).map((p) => <div key={p.id} className="card">{p.name}</div>)}
      <form action={createProject} className="inline" style={{ marginTop: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="project-name">New project</label>
          <input id="project-name" name="name" placeholder="Kompally site" />
        </div>
        <button className="btn secondary">Add</button>
      </form>

      <h2>WhatsApp groups</h2>
      <p className="muted">
        Groups appear here once the bot has been added to them and has seen a message.
        Until a group is pointed at a project, nothing from it is stored.
      </p>
      {(groups ?? []).length === 0 && (
        <p className="muted" style={{ marginTop: 10 }}>No groups yet.</p>
      )}
      {(groups ?? []).map((g) => (
        <form key={g.id} action={linkGroup} className="card">
          <input type="hidden" name="group_id" value={g.id} />
          <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <strong>{g.name ?? g.wa_group_id}</strong>
              <div style={{ marginTop: 8 }}>
                <label htmlFor={`p-${g.id}`}>Project</label>
                <select id={`p-${g.id}`} name="project_id" defaultValue={g.project_id ?? ''}>
                  <option value="">Not linked</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className="btn secondary">Save</button>
          </div>
        </form>
      ))}

      <h2>Categories</h2>
      <div className="card">{(categories ?? []).map((c) => c.name).join(' · ') || 'None'}</div>
      <form action={createCategory} className="inline" style={{ marginTop: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="category-name">New category</label>
          <input id="category-name" name="name" placeholder="Scaffolding" />
        </div>
        <button className="btn secondary">Add</button>
      </form>
    </main>
  );
}
