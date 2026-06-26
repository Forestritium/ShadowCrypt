import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Rate-limit constants ─────────────────────────────────────────────────────
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const MAX_ATTEMPTS   = 5;               // failed attempts before lockout
const LOCKOUT_MS     = 60 * 60 * 1000; // 1-hour lockout after threshold

// ─── PBKDF2 constants (must match client-side mnemonic.ts) ───────────────────
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES  = 32;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive PBKDF2-SHA256(mnemonic, salt, 100 000 iters, 32 bytes) → Uint8Array. */
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

/** Constant-time hex string comparison — guards against timing side-channels. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SHA-256 hex of a string — keys rate-limit rows without storing plaintext usernames. */
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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
    const usernameHash = await sha256hex(normalizedUsername);
    const now = new Date();

    // ── Step 1: Read rate-limit record and reject if currently locked ─────────
    const { data: rl } = await adminClient
      .from('password_reset_rate_limit')
      .select('id, attempts, window_start, locked_until')
      .eq('username_hash', usernameHash)
      .maybeSingle();

    if (rl?.locked_until && new Date(rl.locked_until) > now) {
      return jsonResponse({ error: 'Too many attempts. Please try again later.' }, 429);
    }

    // ── Step 2: Profile lookup ────────────────────────────────────────────────
    const { data: profile, error: profileErr } = await adminClient
      .from('profiles')
      .select('id, mnemonic_hash, mnemonic_salt')
      .eq('username', normalizedUsername)
      .maybeSingle();

    // ── Step 3: PBKDF2 verification (runs even on missing user to equalise timing) ──
    // Using a dummy salt when the user doesn't exist prevents username enumeration
    // via response-time differences between "not found" and "wrong phrase".
    const dummySalt = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 zero-bytes, base64
    const lookupFailed = !!(profileErr || !profile);
    const saltToUse    = lookupFailed ? dummySalt : (profile.mnemonic_salt ?? dummySalt);

    const incomingHashBytes = await hashMnemonic(mnemonic, saltToUse);
    const incomingHashHex   = Array.from(incomingHashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // Inner helper: increment the failure counter, then throw with the given message.
    // Applies lockout when the threshold is reached.
    async function failWithCount(message: string): Promise<never> {
      if (!rl) {
        // First recorded failure for this username
        await adminClient
          .from('password_reset_rate_limit')
          .insert({ username_hash: usernameHash, attempts: 1, window_start: now.toISOString() });
      } else {
        const windowStart  = new Date(rl.window_start);
        const windowExpired = (now.getTime() - windowStart.getTime()) > RATE_WINDOW_MS;
        const newAttempts   = windowExpired ? 1 : rl.attempts + 1;
        const lockedUntil   = newAttempts >= MAX_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
          : null;

        await adminClient
          .from('password_reset_rate_limit')
          .update({
            attempts:     newAttempts,
            window_start: windowExpired ? now.toISOString() : rl.window_start,
            locked_until: lockedUntil,
          })
          .eq('id', rl.id);
      }
      throw new Error(message);
    }

    // ── Step 4: Check lookup result ───────────────────────────────────────────
    if (lookupFailed) {
      await failWithCount('User not found.');
    }

    // Reject legacy accounts that have no salt (unsalted SHA-256 stored pre-migration).
    // Counter is NOT incremented here — this isn't a wrong-phrase attempt, it's a
    // configuration state that the user must resolve by logging in and regenerating.
    if (!profile!.mnemonic_salt) {
      throw new Error(
        'Your recovery phrase was stored with an older format. ' +
        'Please log in and regenerate it from Settings before using password reset.'
      );
    }

    if (!profile!.mnemonic_hash) {
      throw new Error('No recovery phrase on file for this account.');
    }

    // ── Step 5: Constant-time comparison ─────────────────────────────────────
    if (!timingSafeEqualHex(incomingHashHex, profile!.mnemonic_hash)) {
      await failWithCount('Recovery phrase does not match. Please check each word carefully.');
    }

    // ── Step 6: Reset password ────────────────────────────────────────────────
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(profile!.id, {
      password: newPassword,
    });
    if (updateErr) throw new Error(`Failed to reset password: ${updateErr.message}`);

    // ── Step 7: On success — reset rate-limit record ──────────────────────────
    await adminClient
      .from('password_reset_rate_limit')
      .delete()
      .eq('username_hash', usernameHash);

    // Mark profile as using the new password format (non-fatal if it fails)
    const { error: profileUpdateErr } = await adminClient
      .from('profiles')
      .update({ password_version: 1 })
      .eq('id', profile!.id);
    if (profileUpdateErr) {
      console.error('Failed to update password_version after reset:', profileUpdateErr);
    }

    return jsonResponse({ success: true }, 200);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Use 429 for rate-limit messages, 400 for all other errors
    const status = msg.startsWith('Too many') ? 429 : 400;
    return jsonResponse({ error: msg }, status);
  }
});
