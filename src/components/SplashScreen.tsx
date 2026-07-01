/**
 * SplashScreen — shown after successful login/registration.
 * Runs a 3-stage progress sequence (Frontend → Backend → Database)
 * then calls onComplete to navigate to /chat.
 */

import { useEffect, useState } from 'react';
import { Shield, Lock, Zap } from 'lucide-react';
import logoUrl from '@/assets/logo.svg';

const APP_VERSION = 'v4.0.0 (Web)';

const STAGES = [
  { label: 'Initializing frontend...', target: 30, duration: 600 },
  { label: 'Connecting to relay server...', target: 65, duration: 900 },
  { label: 'Unlocking encrypted vault...', target: 95, duration: 800 },
  { label: 'Ready.', target: 100, duration: 400 },
];

interface SplashScreenProps {
  onComplete: () => void;
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState(STAGES[0].label);
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let currentProgress = 0;

    const runStages = async () => {
      for (let s = 0; s < STAGES.length; s++) {
        if (cancelled) return;
        const stage = STAGES[s];
        setStageLabel(stage.label);
        setStageIndex(s);

        const gap = stage.target - currentProgress;
        const steps = 20;
        const stepDelay = stage.duration / steps;
        const stepSize = gap / steps;

        for (let i = 0; i < steps; i++) {
          if (cancelled) return;
          await new Promise<void>(res => setTimeout(res, stepDelay));
          currentProgress = Math.min(currentProgress + stepSize, stage.target);
          setProgress(Math.round(currentProgress));
        }
      }

      if (!cancelled) {
        await new Promise<void>(res => setTimeout(res, 300));
        if (!cancelled) onComplete();
      }
    };

    runStages();
    return () => { cancelled = true; };
  }, [onComplete]);

  const stageIcons = [<Zap key="zap" className="w-3.5 h-3.5" />, <Shield key="shield" className="w-3.5 h-3.5" />, <Lock key="lock" className="w-3.5 h-3.5" />];

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
      <div className="flex flex-col items-center gap-8 px-8 w-full max-w-xs">
        {/* Logo */}
        <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center overflow-hidden shadow-sm">
          <img src={logoUrl} alt="ShadowCrypt" className="w-14 h-14 object-contain" />
        </div>

        {/* Brand */}
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">ShadowCrypt</h1>
          <p className="text-sm text-muted-foreground">Zero-knowledge encrypted messaging</p>
        </div>

        {/* Progress */}
        <div className="w-full space-y-3">
          {/* Bar */}
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Stage label */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              <span className="text-primary shrink-0">
                {stageIcons[Math.min(stageIndex, stageIcons.length - 1)]}
              </span>
              <span className="truncate">{stageLabel}</span>
            </div>
            <span className="text-xs text-primary font-medium tabular-nums ml-3 shrink-0">{progress}%</span>
          </div>

          {/* Stage dots */}
          <div className="flex items-center justify-center gap-2">
            {STAGES.slice(0, 3).map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-all duration-500 ${
                  i < stageIndex ? 'w-6 bg-primary' : i === stageIndex ? 'w-4 bg-primary/60' : 'w-2 bg-muted'
                }`}
              />
            ))}
          </div>
        </div>

        {/* E2E badges */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {[
            { icon: <Shield className="w-3 h-3" />, label: 'E2E Encrypted' },
            { icon: <Lock className="w-3 h-3" />, label: 'Double Ratchet' },
            { icon: <Zap className="w-3 h-3" />, label: 'Zero Knowledge' },
          ].map(b => (
            <span key={b.label} className="inline-flex items-center gap-1 text-xs text-primary bg-primary/10 rounded-full px-2.5 py-1">
              {b.icon}{b.label}
            </span>
          ))}
        </div>

        {/* Footer */}
        <div className="text-center space-y-0.5">
          <p className="text-xs text-muted-foreground/60 font-mono">{APP_VERSION}</p>
          <p className="text-xs text-muted-foreground/40">Developed by Forestritium</p>
        </div>
      </div>
    </div>
  );
}
