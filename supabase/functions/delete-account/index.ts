import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';



export function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin');
  const allowedOrigins = ['http://localhost:5173', 'http://localhost:8080'];
  if (!origin || (!allowedOrigins.includes(origin) && !origin.endsWith('.sylvacrypt.com') && origin !== 'https://sylvacrypt.com')) {
    return {
      'Access-Control-Allow-Origin': '',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'X-Content-Type-Options': 'nosniff',
    };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'X-Content-Type-Options': 'nosniff',
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    // Get the calling user from the JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization header');

    // Regular client to verify the JWT
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) throw new Error('Invalid or expired token');

    const { password } = await req.json().catch(() => ({ password: null }));
    if (!password) {
      throw new Error('Password required for account deletion');
    }

    const { error: signInErr } = await userClient.auth.signInWithPassword({
      email: user.email!,
      password
    });
    if (signInErr) {
      throw new Error('Incorrect password');
    }

    // Service-role client to perform admin operations
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const buckets = ['chat-images', 'chat-voices', 'chat-files', 'avatars'];
    for (const bucket of buckets) {
      try {
        const { data: files } = await adminClient.storage.from(bucket).list(user.id);
        if (files && files.length > 0) {
          const paths = files.map((f: any) => `${user.id}/${f.name}`);
          await adminClient.storage.from(bucket).remove(paths);
        }
      } catch (e) {
        console.error(`Failed to cleanup bucket ${bucket} for user ${user.id}:`, e);
      }
    }

    const { error: profileErr } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', user.id);
    if (profileErr) throw new Error(`Failed to delete profile: ${profileErr.message}`);

    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteErr) throw new Error(`Failed to delete auth user: ${deleteErr.message}`);

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400 }
    );
  }
});
