import { describe, it, expect } from 'vitest';
import { filterEmojisByQuery } from '../EmojiReactionPicker';

describe('EmojiReactionPicker search', () => {
  it('finds emojis by keyword', () => {
    expect(filterEmojisByQuery('thumbs')).toContain('👍');
    expect(filterEmojisByQuery('love')).toContain('❤️');
  });

  it('finds emojis by category label', () => {
    expect(filterEmojisByQuery('smileys')).not.toHaveLength(0);
  });

  it('finds emojis by direct emoji input', () => {
    expect(filterEmojisByQuery('👍')).toContain('👍');
  });

  it('returns an empty array for non-matching queries', () => {
    expect(filterEmojisByQuery('xyznonexistent')).toEqual([]);
  });

  it('returns an empty array for empty queries', () => {
    expect(filterEmojisByQuery('')).toEqual([]);
    expect(filterEmojisByQuery('   ')).toEqual([]);
  });
});
