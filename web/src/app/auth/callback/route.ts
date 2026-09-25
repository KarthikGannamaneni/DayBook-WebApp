import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

/** Exchanges the magic-link code for a session cookie, then lands on Projects. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }

  return NextResponse.redirect(`${origin}/sign-in?error=link`);
}
