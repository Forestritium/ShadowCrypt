import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { dictionary, translations } from '@zxcvbn-ts/language-en';

// One-time initialisation of the English dictionary
const zxcvbn = new ZxcvbnFactory({
  translations,
  dictionary: {
    ...dictionary,
  },
});

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface StrengthResult {
  score: StrengthScore;
  label: string;
  color: string;
  feedback: string;
  crackTimeDisplay: string;
}

const LABELS: Record<StrengthScore, string> = {
  0: 'Very Weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

const COLORS: Record<StrengthScore, string> = {
  0: 'bg-destructive',
  1: 'bg-orange-500',
  2: 'bg-yellow-500',
  3: 'bg-blue-500',
  4: 'bg-green-500',
};

export function estimatePasswordStrength(password: string): StrengthResult {
  const result = zxcvbn.check(password);
  const score = Math.min(4, Math.max(0, result.score)) as StrengthScore;

  const warning = result.feedback.warning ?? '';
  const suggestions = result.feedback.suggestions ?? [];
  const feedback = warning || suggestions[0] || '';

  return {
    score,
    label: LABELS[score],
    color: COLORS[score],
    feedback,
    crackTimeDisplay: result.crackTimes.offlineSlowHashingXPerSecond.display,
  };
}
