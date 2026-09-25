import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Hands back a short-lived signed URL for one bill.
 *
 * The ownership check is the SELECT itself: this client carries the user's
 * session, so row-level security returns nothing for a file belonging to
 * anyone else. There is no public URL for any bill, ever.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data: file } = await supabase
    .from('expense_files')
    .select('storage_path, mime_type')
    .eq('id', id)
    .maybeSingle();

  // Missing and not-yours are deliberately the same answer.
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const account = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!account || !accessKeyId || !secretAccessKey || !bucket) {
    return NextResponse.json({ error: 'file storage is not configured' }, { status: 503 });
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: file.storage_path }),
    { expiresIn: 300 },
  );

  return NextResponse.redirect(url);
}
