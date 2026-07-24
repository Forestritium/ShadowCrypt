import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getCustomTheme } from '@/lib/customThemesStore';
import { hexToHSLString, isColorDark } from '@/lib/colorUtils';

type Theme = string;

interface AutoSchedule {
  enabled: boolean;
  lightStart: string; // HH:MM
  darkStart: string;  // HH:MM
  lightTheme: Theme;
  darkTheme: Theme;
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  autoSchedule: AutoSchedule;
  setAutoSchedule: (schedule: AutoSchedule) => void;
}

const defaultAutoSchedule: AutoSchedule = {
  enabled: false,
  lightStart: '07:00',
  darkStart: '19:00',
  lightTheme: 'light',
  darkTheme: 'dark',
};

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
  autoSchedule: defaultAutoSchedule,
  setAutoSchedule: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('sc_theme') as Theme | null;
      return stored ? stored : 'dark';
    } catch {
      return 'dark';
    }
  });

  const [autoSchedule, setAutoScheduleState] = useState<AutoSchedule>(() => {
    try {
      const raw = localStorage.getItem('sc_theme_auto');
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...defaultAutoSchedule, ...parsed };
      }
    } catch { /* ignore */ }
    return defaultAutoSchedule;
  });

  const isDarkTheme = (t: Theme) => ['dark', 'mint-dark', 'ember', 'neon-noir'].includes(t);

  const toggleTheme = () => {
    setTheme(current => {
      if (isDarkTheme(current)) {
        return (localStorage.getItem('sc_theme_light') as Theme) || 'light';
      } else {
        return (localStorage.getItem('sc_theme_dark') as Theme) || 'dark';
      }
    });
  };

  const setAutoSchedule = (schedule: AutoSchedule) => {
    setAutoScheduleState(schedule);
    try { localStorage.setItem('sc_theme_auto', JSON.stringify(schedule)); } catch { /* ignore */ }
  };

  const applyScheduledTheme = (schedule: AutoSchedule) => {
    if (!schedule.enabled) return;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [lh, lm] = schedule.lightStart.split(':').map(Number);
    const [dh, dm] = schedule.darkStart.split(':').map(Number);
    const lightMinutes = (lh || 0) * 60 + (lm || 0);
    const darkMinutes = (dh || 0) * 60 + (dm || 0);
    const next = lightMinutes <= darkMinutes
      ? (minutes >= lightMinutes && minutes < darkMinutes ? schedule.lightTheme : schedule.darkTheme)
      : (minutes >= darkMinutes && minutes < lightMinutes ? schedule.darkTheme : schedule.lightTheme);
    setTheme(next);
  };

  const [previewCustomTheme, setPreviewCustomTheme] = useState<any>(null);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'THEME_PREVIEW') {
        setPreviewCustomTheme(e.data.theme);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'theme-mint', 'theme-mint-dark', 'theme-ember', 'theme-neon-noir');
    
    // Remove old custom style if exists
    const oldStyle = document.getElementById('sc-custom-theme-style');
    if (oldStyle) oldStyle.remove();

    if (previewCustomTheme || theme.startsWith('custom_')) {
      const applyTheme = (ct: any) => {
        if (!ct) return;
        
        const config = ct.id === 'preview' ? {
          backgroundColor: ct.bgColor,
          messageBubbleColor: ct.msgColor,
          sendButtonColor: ct.sendColor,
          headerColor: ct.headerColor,
          sidebarColor: ct.sidebarColor,
          cardColor: ct.cardColor,
          receivedBubbleColor: ct.recvColor,
          backgroundType: ct.bgType,
          backgroundImageDataUrl: ct.bgImage,
          fontFamily: ct.font,
          glassmorphism: ct.glassmorphism,
          glassmorphismUi: ct.glassmorphismUi
        } : ct.config;

        // Force the color mode of the preview theme
        if (ct.mode) {
          root.classList.remove('light', 'dark');
          root.classList.add(ct.mode);
        }

        const bgHsl = hexToHSLString(config.backgroundColor);
        const msgHsl = hexToHSLString(config.messageBubbleColor);
        const sendHsl = hexToHSLString(config.sendButtonColor);
        
        const isBgDark = isColorDark(config.backgroundColor);
        const isMsgDark = isColorDark(config.messageBubbleColor);
        const isSendDark = isColorDark(config.sendButtonColor);
        const isHeaderDark = config.headerColor ? isColorDark(config.headerColor) : isBgDark;
        const isSidebarDark = config.sidebarColor ? isColorDark(config.sidebarColor) : isBgDark;
        
        const headerHsl = config.headerColor ? hexToHSLString(config.headerColor) : bgHsl;
        const sidebarHsl = config.sidebarColor ? hexToHSLString(config.sidebarColor) : bgHsl;
        const cardHsl = config.cardColor ? hexToHSLString(config.cardColor) : (isBgDark ? '0 0% 10% / 0.8' : '0 0% 100% / 0.8');
        
        const recvHsl = config.receivedBubbleColor ? hexToHSLString(config.receivedBubbleColor) : cardHsl;
        const isRecvDark = config.receivedBubbleColor ? isColorDark(config.receivedBubbleColor) : isBgDark;
        const recvForeground = isRecvDark ? '0 0% 100%' : '220 13% 13%';
        
        const foreground = isBgDark ? '0 0% 100%' : '220 13% 13%';
        const headerForeground = isHeaderDark ? '0 0% 100%' : '220 13% 13%';
        const sidebarForeground = isSidebarDark ? '0 0% 100%' : '220 13% 13%';
        const borderHsl = isBgDark ? '0 0% 100% / 0.1' : '0 0% 0% / 0.1';
        
        const msgForeground = isMsgDark ? '0 0% 100%' : '220 13% 13%';
        const sendForeground = isSendDark ? '0 0% 100%' : '220 13% 13%';

        if (isBgDark) {
          root.classList.add('dark');
        }

        const styleEl = document.createElement('style');
        styleEl.id = 'sc-custom-theme-style';
        
        let bgImgCss = '';
        if (config.backgroundType === 'image' && config.backgroundImageDataUrl) {
          bgImgCss = `background-image: url("${config.backgroundImageDataUrl}"); background-size: cover; background-position: center; background-attachment: fixed;`;
        } else if (config.backgroundType === 'color' || !config.backgroundType) {
          bgImgCss = `background-color: hsl(${bgHsl});`;
        }
        
        const getGlassCss = (baseHsl: string, fgHsl: string, isUi: boolean) => (isUi ? config.glassmorphismUi : config.glassmorphism) ? `
          backdrop-filter: blur(12px) !important;
          background-color: hsl(${baseHsl} / 0.15) !important;
          border: 1px solid ${isBgDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'} !important;
          box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1) !important;
          color: hsl(${fgHsl}) !important;
        ` : '';

        styleEl.innerHTML = `
          :root {
            --background: ${bgHsl};
            --foreground: ${foreground};
            --card: ${cardHsl};
            --card-foreground: ${foreground};
            --popover: ${bgHsl};
            --popover-foreground: ${foreground};
            --border: ${borderHsl};
            --input: ${borderHsl};
            
            --primary: ${sendHsl};
            --primary-foreground: ${sendForeground};
            
            --bubble-sent-bg: hsl(${msgHsl});
            --bubble-sent-text: hsl(${msgForeground});
            --bubble-recv-bg: hsl(${recvHsl});
            --bubble-recv-text: hsl(${recvForeground});
            --bubble-recv-border: transparent;
            
            --font-sans: ${config.fontFamily || 'Inter'}, sans-serif;
          }
          body {
            ${bgImgCss}
            font-family: var(--font-sans);
          }
          .bg-card {
            background-color: hsl(${cardHsl});
            ${config.glassmorphismUi ? getGlassCss(cardHsl, foreground, true) : 'backdrop-filter: blur(10px);'}
          }
          header, .border-b.bg-card {
            background-color: hsl(${headerHsl}) !important;
            color: hsl(${headerForeground});
            ${getGlassCss(headerHsl, headerForeground, true)}
          }
          aside, nav {
            background-color: hsl(${sidebarHsl}) !important;
            color: hsl(${sidebarForeground});
            ${getGlassCss(sidebarHsl, sidebarForeground, true)}
          }
          .bubble-sent {
            ${getGlassCss(msgHsl, msgForeground, false)}
          }
          .bubble-received {
            ${getGlassCss(recvHsl, recvForeground, false)}
          }
        `;
        document.head.appendChild(styleEl);
      };

      if (previewCustomTheme) {
        applyTheme(previewCustomTheme);
      } else {
        getCustomTheme(theme).then(applyTheme);
      }
    } else {
      if (theme === 'dark') {
        root.classList.add('dark');
      } else if (theme === 'mint') {
        root.classList.add('theme-mint');
      } else if (theme === 'mint-dark') {
        root.classList.add('dark', 'theme-mint-dark');
      } else if (theme === 'ember') {
        root.classList.add('dark', 'theme-ember');
      } else if (theme === 'neon-noir') {
        root.classList.add('dark', 'theme-neon-noir');
      }
    }

    try {
      localStorage.setItem('sc_theme', theme);
      if (isDarkTheme(theme)) {
        localStorage.setItem('sc_theme_dark', theme);
      } else if (!theme.startsWith('custom_')) {
        localStorage.setItem('sc_theme_light', theme);
      }
    } catch { /* ignore */ }
  }, [theme]);

  // Auto-scheduling effect
  useEffect(() => {
    if (!autoSchedule.enabled) return;
    applyScheduledTheme(autoSchedule);
    const id = setInterval(() => applyScheduledTheme(autoSchedule), 60 * 1000);
    return () => clearInterval(id);
  }, [autoSchedule]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, autoSchedule, setAutoSchedule }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
