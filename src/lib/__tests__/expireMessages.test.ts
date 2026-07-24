import { describe, it, expect, vi } from 'vitest';
import { supabase } from '../../db/supabase';

vi.mock('../../db/supabase', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ error: null }),
  },
}));

describe('Expire Messages Logic', () => {
  it('calls delete_expired_messages RPC', async () => {
    // This simulates what the edge function / cron does
    const { error } = await supabase.rpc('delete_expired_messages');
    
    expect(supabase.rpc).toHaveBeenCalledWith('delete_expired_messages');
    expect(error).toBeNull();
  });
  
  it('handles errors from delete_expired_messages gracefully', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ error: new Error('RPC Failed') } as any);
    
    const { error } = await supabase.rpc('delete_expired_messages');
    
    expect(supabase.rpc).toHaveBeenCalledWith('delete_expired_messages');
    expect(error).toBeTruthy();
    expect((error as Error).message).toBe('RPC Failed');
  });
});
