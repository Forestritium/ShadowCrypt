import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../../db/supabase';

// Mock crypto BEFORE importing relay
vi.mock('../crypto', () => ({
  generateKeyPair: vi.fn(),
  encryptSymmetric: vi.fn(),
  decryptSymmetric: vi.fn(),
}));

import { acceptContactRequest, rejectContactRequest } from '../relay';

vi.mock('../../db/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

describe('Contact Requests Flow', () => {
  let updateMock: any;
  let eqMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    eqMock = vi.fn().mockResolvedValue({ error: null });
    updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as any).mockReturnValue({
      update: updateMock,
    });
  });

  it('acceptContactRequest updates status to accepted', async () => {
    const result = await acceptContactRequest('req-123');
    
    expect(supabase.from).toHaveBeenCalledWith('contact_requests');
    expect(updateMock).toHaveBeenCalledWith({ status: 'accepted' });
    expect(eqMock).toHaveBeenCalledWith('id', 'req-123');
    expect(result.error).toBeNull();
  });

  it('rejectContactRequest updates status to rejected', async () => {
    const result = await rejectContactRequest('req-456');
    
    expect(supabase.from).toHaveBeenCalledWith('contact_requests');
    expect(updateMock).toHaveBeenCalledWith({ status: 'rejected' });
    expect(eqMock).toHaveBeenCalledWith('id', 'req-456');
    expect(result.error).toBeNull();
  });

  it('returns error if update fails', async () => {
    eqMock.mockResolvedValue({ error: { message: 'Database error' } });
    
    const result = await acceptContactRequest('req-err');
    
    expect(result.error).toBe('Database error');
  });
});
