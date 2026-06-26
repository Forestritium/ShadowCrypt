import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Rate-limit constants ─────────────────────────────────────────────────────
const RATE_WINDOW_MS  = 15 * 60 * 1000; // 15-minute sliding window
const MAX_ATTEMPTS    = 5;               // attempts before lockout
const LOCKOUT_MS      = 60 * 60 * 1000; // 1-hour lockout after threshold

// ─── PBKDF2 constants (must match client-side mnemonic.ts) ───────────────────
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES  = 32;

/** Derive PBKDF2-SHA256 hash of a mnemonic using its per-user salt. */
async function hashMnemonic(mnemonic: string, saltBase64: string): Promise<Uint8Array> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const saltBytes = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEY_BYTES * 8
  );
  return new Uint8Array(derived);
}

/** Constant-time comparison of two hex strings (guards against timing side-channels). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** SHA-256 hex of a string — used to key rate-limit records without storing plaintext usernames. */
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const { username, mnemonic, newPassword } = await req.json();
    if (!username || !mnemonic || !newPassword) {
      throw new Error('Missing required fields: username, mnemonic, newPassword');
    }

    const normalizedUsername = username.trim().toLowerCase();

    // ── Rate-limit check ──────────────────────────────────────────────────────
    const usernameHash = await sha256hex(normalizedUsername);
    const now = new Date();

    const { data: rl } = await adminClient
      .from('password_reset_rate_limit')
      .select('id, attempts, window_start, locked_until')
      .eq('username_hash', usernameHash)
      .maybeSingle();

    if (rl) {
      // Still within lockout period
      if (rl.locked_until && new Date(rl.locked_until) > now) {
        return new Response(
          JSON.stringify({ error: 'Too many attempts. Please try again later.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 429 }
        );
      }

      const windowStart = new Date(rl.window_start);
      const windowExpired = (now.getTime() - windowStart.getTime()) > RATE_WINDOW_MS;

      if (!windowExpired && rl.attempts >= MAX_ATTEMPTS) {
        // Exceeded threshold — set lockout
        await adminClient
          .from('password_reset_rate_limit')
          .update({ locked_until: new Date(now.getTime() + LOCKOUT_MS).toISOString() })
          .eq('id', rl.id);
        return new Response(
          JSON.stringify({ error: 'Too many attempts. Please try again later.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 429 }
        );
      }

      if (windowExpired) {
        // Reset window
        await adminClient
          .from('password_reset_rate_limit')
          .update({ attempts: 1, window_start: now.toISOString(), locked_until: null })
          .eq('id', rl.id);
      } else {
        await adminClient
          .from('password_reset_rate_limit')
          .update({ attempts: rl.attempts + 1 })
          .eq('id', rl.id);
      }
    } else {
      // First attempt for this username
      await adminClient
        .from('password_reset_rate_limit')
        .insert({ username_hash: usernameHash, attempts: 1, window_start: now.toISOString() });
    }

    // ── Profile lookup ────────────────────────────────────────────────────────
    const { data: profile, error: profileErr } = await adminClient
      .from('profiles')
      .select('id, mnemonic_hash, mnemonic_salt')
      .eq('username', normalizedUsername)
      .maybeSingle();

    // Run a dummy PBKDF2 even when the user doesn't exist to equalise response timing
    // and prevent username enumeration via timing differences.
    const dummySalt = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 zero-bytes, base64
    const lookupFailed = profileErr || !profile;
    const saltToUse   = lookupFailed ? dummySalt : (profile.mnemonic_salt ?? dummySalt);

    const incomingHashBytes = await hashMnemonic(mnemonic, saltToUse);
    const incomingHashHex   = Array.from(incomingHashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    if (lookupFailed) {
      throw new Error('User not found.');
    }
    if (!profile.mnemonic_hash || !profile.mnemonic_salt) {
      throw new Error(
        'Your recovery phrase was stored with an older format. ' +
        'Please log in and regenerate it from Settings before using password reset.'
      );
    }

    // ── Constant-time verification ────────────────────────────────────────────
    if (!timingSafeEqualHex(incomingHashHex, profile.mnemonic_hash)) {
      throw new Error('Recovery phrase does not match. Please check each word carefully.');
    }

    // ── Reset password ────────────────────────────────────────────────────────
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(profile.id, {
      password: newPassword,
    });
    if (updateErr) throw new Error(`Failed to reset password: ${updateErr.message}`);

    // Clear rate-limit record on success
    await adminClient.from('password_reset_rate_limit').delete().eq('username_hash', usernameHash);

    // Mark profile as using the new password format
    const { error: profileUpdateErr } = await adminClient
      .from('profiles')
      .update({ password_version: 1 })
      .eq('id', profile.id);
    if (profileUpdateErr) {
      console.error('Failed to update password_version after reset:', profileUpdateErr);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    );
  }
});
