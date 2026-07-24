const EMOJI_STORAGE_KEY = 'sc_frequent_emojis';
const MAX_FREQUENT_EMOJIS = 18;

export function getFrequentEmojis(): string[] {
  try {
    const stored = localStorage.getItem(EMOJI_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    // ignore
  }
  return [];
}

export function addFrequentEmoji(emoji: string) {
  const current = getFrequentEmojis();
  const index = current.indexOf(emoji);
  if (index > -1) {
    current.splice(index, 1);
  }
  current.unshift(emoji);
  if (current.length > MAX_FREQUENT_EMOJIS) {
    current.pop();
  }
  localStorage.setItem(EMOJI_STORAGE_KEY, JSON.stringify(current));
}
