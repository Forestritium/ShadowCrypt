import { useState, useEffect } from 'react';

export type WaveformType = 'legacy' | 'modern';

export interface WaveformSettings {
  type: WaveformType;
  color: string;
}

const defaultSettings: WaveformSettings = {
  type: 'modern',
  color: 'primary',
};

export function useWaveformSettings() {
  const [settings, setSettings] = useState<WaveformSettings>(() => {
    try {
      const stored = localStorage.getItem('sc_waveform_settings');
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });

  const updateSettings = (newSettings: Partial<WaveformSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...newSettings };
      try {
        localStorage.setItem('sc_waveform_settings', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'sc_waveform_settings' && e.newValue) {
        try {
          setSettings({ ...defaultSettings, ...JSON.parse(e.newValue) });
        } catch {}
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return { settings, updateSettings };
}
