'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { supabase } from '@/lib/client';
import { useSession } from '@/lib/useSession';

function Settings() {
  const { user } = useSession();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string | null; wa_group_id: string; project_id: string | null }>>([]);
  const [projectName, setProjectName] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = supabase();
    const [p, c, g] = await Promise.all([
      client.from('projects').select('id, name').is('archived_at', null).order('name'),
      client.from('categories').select('id, name').order('name'),
      client.from('whatsapp_groups').select('id, name, wa_group_id, project_id').order('created_at'),
    ]);
    setProjects(p.data ?? []);
    setCategories(c.data ?? []);
    setGroups(g.data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addProject(event: React.FormEvent) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) { setError('Give the project a name'); return; }
    if (!user) return;
    setError(null);
    const { error: insertError } = await supabase().from('projects').insert({ owner_id: user.id, name });
    if (insertError) setError(insertError.message);
    else { setProjectName(''); void load(); }
  }

  async function addCategory(event: React.FormEvent) {
    event.preventDefault();
    const name = categoryName.trim();
    if (!name) { setError('Give the category a name'); return; }
    if (!user) return;
    setError(null);
    const { error: insertError } = await supabase().from('categories').insert({ owner_id: user.id, name });
    if (insertError) setError(insertError.message);
    else { setCategoryName(''); void load(); }
  }

  async function link(groupId: string, projectId: string) {
    await supabase()
      .from('whatsapp_groups')
      .update({ project_id: projectId || null, linked_at: projectId ? new Date().toISOString() : null })
      .eq('id', groupId);
    void load();
  }

  async function signOut() {
    await supabase().auth.signOut();
    window.location.assign('/');
  }

  return (
    <main>
      <TopNav back={{ href: '/', label: 'Projects' }} />
      <h1>Settings</h1>
      {error && <p role="alert" style={{ color: '#a32d2d', fontSize: 14 }}>{error}</p>}

      <h2>Projects</h2>
      {projects.map((p) => <div key={p.id} className="card">{p.name}</div>)}
      <form onSubmit={addProject} className="inline" style={{ marginTop: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="project-name">New project</label>
          <input id="project-name" value={projectName} onChange={(e) => setProjectName(e.target.value)}
            placeholder="Kompally site" />
        </div>
        <button className="btn secondary">Add</button>
      </form>

      <h2>WhatsApp groups</h2>
      <p className="muted">
        Groups appear once the bot has been added and has seen a message. Until a group is pointed
        at a project, nothing from it is stored.
      </p>
      {groups.length === 0 && <p className="muted" style={{ marginTop: 10 }}>No groups yet.</p>}
      {groups.map((g) => (
        <div key={g.id} className="card">
          <strong>{g.name ?? g.wa_group_id}</strong>
          <div style={{ marginTop: 8 }}>
            <label htmlFor={`p-${g.id}`}>Project</label>
            <select id={`p-${g.id}`} defaultValue={g.project_id ?? ''}
              onChange={(e) => void link(g.id, e.target.value)}>
              <option value="">Not linked</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      ))}

      <h2>Categories</h2>
      <div className="card">{categories.map((c) => c.name).join(' · ') || 'None'}</div>
      <form onSubmit={addCategory} className="inline" style={{ marginTop: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="category-name">New category</label>
          <input id="category-name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)}
            placeholder="Scaffolding" />
        </div>
        <button className="btn secondary">Add</button>
      </form>

      <h2>This device</h2>
      <p className="muted">{user?.email}</p>
      <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}

export default function Page() {
  return <Protected><Settings /></Protected>;
}
