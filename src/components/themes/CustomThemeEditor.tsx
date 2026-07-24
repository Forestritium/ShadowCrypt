import { generateUUID } from "@/lib/uuid";
import { useState, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { CustomTheme } from '@/lib/customThemesStore';
import { saveCustomTheme } from '@/lib/customThemesStore';
import { UploadCloud, Smartphone, Monitor, Send } from 'lucide-react';
import { hexToHSLString, isColorDark } from '@/lib/colorUtils';

const ColorPickerCircle = ({ value, onChange, label }: { value: string, onChange: (v: string) => void, label: string }) => (
  <div className="flex flex-col items-center gap-2 shrink-0">
    <div 
      className="w-12 h-12 rounded-full overflow-hidden border-2 border-border shadow-sm cursor-pointer relative"
      style={{ backgroundColor: value }}
    >
      <input 
        type="color" 
        value={value} 
        onChange={e => onChange(e.target.value)} 
        className="opacity-0 absolute inset-0 w-[200%] h-[200%] cursor-pointer -translate-x-1/4 -translate-y-1/4" 
        title={label}
      />
    </div>
    <span className="text-[10px] text-muted-foreground text-center leading-tight max-w-[60px]">{label}</span>
  </div>
);

export function CustomThemeEditor({ 
  open, 
  onClose, 
  initialTheme, 
  onSave 
}: { 
  open: boolean; 
  onClose: () => void; 
  initialTheme?: CustomTheme; 
  onSave: () => void; 
}) {
  const [name, setName] = useState(initialTheme?.name ?? '');
  const [description, setDescription] = useState(initialTheme?.description ?? '');
  const [mode, setMode] = useState<'light' | 'dark'>(initialTheme?.mode ?? 'dark');
  const [isPublic, setIsPublic] = useState(initialTheme?.isPublic ?? false);
  const [msgColor, setMsgColor] = useState(initialTheme?.config?.messageBubbleColor ?? '#4a5c50');
  const [recvColor, setRecvColor] = useState(initialTheme?.config?.receivedBubbleColor ?? '#232a26');
  const [sendColor, setSendColor] = useState(initialTheme?.config?.sendButtonColor ?? '#6b8a75');
  const [bgColor, setBgColor] = useState(initialTheme?.config?.backgroundColor ?? '#1a1f1c');
  const [font, setFont] = useState(initialTheme?.config?.fontFamily ?? 'Inter');
  const [bgImage, setBgImage] = useState<string | undefined>(initialTheme?.config?.backgroundImageDataUrl);
  const [bgType, setBgType] = useState<'color' | 'image'>(initialTheme?.config?.backgroundType ?? 'color');
  
  const [headerColor, setHeaderColor] = useState(initialTheme?.config?.headerColor ?? '#1a1f1c');
  const [sidebarColor, setSidebarColor] = useState(initialTheme?.config?.sidebarColor ?? '#161a18');
  const [cardColor, setCardColor] = useState(initialTheme?.config?.cardColor ?? '#232a26');
  const [glassmorphism, setGlassmorphism] = useState(initialTheme?.config?.glassmorphism ?? false);
  const [glassmorphismUi, setGlassmorphismUi] = useState(initialTheme?.config?.glassmorphismUi ?? false);
  const [isDragging, setIsDragging] = useState(false);
  
  // Auto-detect device for default preview mode
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>(window.innerWidth < 768 ? 'mobile' : 'desktop');

  // Use a ref to keep track of the current theme ID to avoid regenerating random UUIDs on every render
  const themeIdRef = useRef(initialTheme?.id ?? `custom_${generateUUID()}`);
  const statusRef = useRef(initialTheme?.status ?? 'draft');

  useEffect(() => {
    const handleAutosave = async () => {
      const theme: CustomTheme = {
        id: themeIdRef.current,
        name: name.trim() || 'Untitled Draft',
        description: description.trim(),
        mode,
        isPublic,
        status: 'draft',
        config: {
          messageBubbleColor: msgColor,
          receivedBubbleColor: recvColor,
          sendButtonColor: sendColor,
          backgroundColor: bgColor,
          backgroundType: bgType,
          fontFamily: font,
          backgroundImageDataUrl: bgImage,
          headerColor,
          sidebarColor,
          cardColor,
          glassmorphism,
          glassmorphismUi
        }
      };
      await saveCustomTheme(theme);
    };

    // Auto-save on any change if it's currently a draft or if we are actively editing
    // Wait for 500ms debounce
    const timer = setTimeout(() => {
      if (statusRef.current === 'draft') {
        handleAutosave();
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [name, description, mode, isPublic, msgColor, recvColor, sendColor, bgColor, bgType, font, bgImage, headerColor, sidebarColor, cardColor, glassmorphism, glassmorphismUi]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setBgImage(ev.target?.result as string);
        setBgType('image');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setBgImage(ev.target?.result as string);
        setBgType('image');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = async (asDraft: boolean) => {
    if (!asDraft && (!name.trim() || !description.trim())) {
      alert("Theme must have a name and description before saving or publishing.");
      return;
    }
    const finalStatus = asDraft || !name.trim() ? 'draft' : 'saved';
    statusRef.current = finalStatus;
    const theme: CustomTheme = {
      id: themeIdRef.current,
      name: name.trim() || 'Untitled Draft',
      description: description.trim(),
      mode,
      isPublic,
      status: finalStatus,
      config: {
        messageBubbleColor: msgColor,
        receivedBubbleColor: recvColor,
        sendButtonColor: sendColor,
        backgroundColor: bgColor,
        backgroundType: bgType,
        fontFamily: font,
        backgroundImageDataUrl: bgImage,
        headerColor,
        sidebarColor,
        cardColor,
        glassmorphism
      }
    };
    await saveCustomTheme(theme);
    
    // Also push to supabase if it is public
    if (isPublic && finalStatus === 'saved') {
      try {
        const { supabase } = await import('@/db/supabase');
        // Check if user is logged in
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const rawId = theme.id.replace('custom_', '').replace('public_', '');
          const isUuid = rawId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          let payloadId = isUuid ? rawId : undefined;
          
          await supabase.from('public_themes').upsert({
            ...(payloadId ? { id: payloadId } : {}),
            name: theme.name,
            description: theme.description,
            mode: theme.mode,
            config: theme.config
          });
        }
      } catch (e) {
        console.error("Failed to publish theme to public directory", e);
      }
    }
    
    onSave();
    onClose();
  };

  const handleCancel = async () => {
    if (window.confirm("Are you sure you want to discard your changes?")) {
      if (initialTheme) {
        // Revert to initialTheme
        await saveCustomTheme(initialTheme);
      } else {
        // Delete the newly created draft
        const { deleteCustomTheme } = await import('@/lib/customThemesStore');
        await deleteCustomTheme(themeIdRef.current);
      }
      onSave(); // Trigger a reload of themes
      onClose();
    }
  };

  const mockCss = useMemo(() => {
    const bgHsl = hexToHSLString(bgColor);
    const msgHsl = hexToHSLString(msgColor);
    const sendHsl = hexToHSLString(sendColor);
    const isBgDark = isColorDark(bgColor);
    const isMsgDark = isColorDark(msgColor);
    const isSendDark = isColorDark(sendColor);
    const isHeaderDark = headerColor ? isColorDark(headerColor) : isBgDark;
    const isSidebarDark = sidebarColor ? isColorDark(sidebarColor) : isBgDark;
    
    const headerHsl = headerColor ? hexToHSLString(headerColor) : bgHsl;
    const sidebarHsl = sidebarColor ? hexToHSLString(sidebarColor) : bgHsl;
    const cardHsl = cardColor ? hexToHSLString(cardColor) : (isBgDark ? '0 0% 10% / 0.8' : '0 0% 100% / 0.8');
    const recvHsl = recvColor ? hexToHSLString(recvColor) : cardHsl;
    
    const isRecvDark = recvColor ? isColorDark(recvColor) : isBgDark;
    
    const recvForeground = isRecvDark ? '0 0% 100%' : '220 13% 13%';
    const foreground = isBgDark ? '0 0% 100%' : '220 13% 13%';
    const borderHsl = isBgDark ? '0 0% 100% / 0.1' : '0 0% 0% / 0.1';
    const msgForeground = isMsgDark ? '0 0% 100%' : '220 13% 13%';
    const sendForeground = isSendDark ? '0 0% 100%' : '220 13% 13%';
    const headerForeground = isHeaderDark ? '0 0% 100%' : '220 13% 13%';
    const sidebarForeground = isSidebarDark ? '0 0% 100%' : '220 13% 13%';

    let bgImgCss = '';
    if (bgType === 'image' && bgImage) {
      bgImgCss = `background-image: url("${bgImage}"); background-size: cover; background-position: center; background-attachment: fixed;`;
    } else {
      bgImgCss = `background-color: hsl(${bgHsl});`;
    }

    const getGlassCss = (baseHsl: string, fgHsl: string, isUi: boolean) => (isUi ? glassmorphismUi : glassmorphism) ? `
      backdrop-filter: blur(12px) !important;
      background-color: hsl(${baseHsl} / 0.15) !important;
      border: 1px solid ${isBgDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'} !important;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1) !important;
      color: hsl(${fgHsl}) !important;
    ` : '';

    return `
      .theme-mock-root {
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
        --font-sans: ${font || 'Inter'}, sans-serif;
        font-family: var(--font-sans);
        color: hsl(var(--foreground));
        ${bgImgCss}
      }
      .theme-mock-root .bg-card {
        background-color: hsl(var(--card));
        color: hsl(var(--card-foreground));
        ${glassmorphismUi ? getGlassCss(cardHsl, foreground, true) : 'backdrop-filter: blur(10px);'}
      }
      .theme-mock-root .theme-mock-header {
        background-color: hsl(${headerHsl});
        color: hsl(${headerForeground});
        border-color: hsl(var(--border));
        ${glassmorphismUi ? getGlassCss(headerHsl, headerForeground, true) : ''}
      }
      .theme-mock-root .theme-mock-sidebar {
        background-color: hsl(${sidebarHsl});
        color: hsl(${sidebarForeground});
        border-color: hsl(var(--border));
        ${glassmorphismUi ? getGlassCss(sidebarHsl, sidebarForeground, true) : ''}
      }
      .theme-mock-root .bubble-sent {
        background: var(--bubble-sent-bg);
        color: var(--bubble-sent-text);
        ${glassmorphism ? getGlassCss(msgHsl, msgForeground, false) : ''}
      }
      .theme-mock-root .bubble-received {
        background: var(--bubble-recv-bg);
        color: var(--bubble-recv-text);
        ${glassmorphism ? getGlassCss(recvHsl, recvForeground, false) : ''}
      }
    `;
  }, [bgColor, msgColor, sendColor, headerColor, sidebarColor, cardColor, recvColor, bgType, bgImage, font, glassmorphism, glassmorphismUi]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-[calc(100%-2rem)] md:max-w-4xl overflow-y-auto max-h-[90dvh]">
        <DialogHeader>
          <DialogTitle>{initialTheme ? 'Edit Custom Theme' : 'Create Custom Theme'}</DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col md:flex-row gap-8 py-4">
          <div className="w-full md:w-5/12 flex flex-col gap-4">
            {/* Live Preview */}
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Live Preview</Label>
              <div className="flex items-center bg-muted rounded-md p-0.5">
                <button 
                  onClick={() => setPreviewMode('mobile')}
                  className={`p-1 rounded-sm transition-colors ${previewMode === 'mobile' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                >
                  <Smartphone className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setPreviewMode('desktop')}
                  className={`p-1 rounded-sm transition-colors ${previewMode === 'desktop' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                >
                  <Monitor className="w-4 h-4" />
                </button>
              </div>
            </div>
            
            <div className="w-full flex justify-center bg-muted/20 rounded-xl p-4 border border-border">
              <style>{mockCss}</style>
              <div 
                className={`theme-mock-root rounded-xl border border-border shadow-md overflow-hidden flex relative transition-all ${previewMode === 'desktop' ? 'w-full h-full flex-row aspect-video' : 'w-full max-w-[260px] aspect-[9/16] flex-col mx-auto'}`}
              >
                {previewMode === 'desktop' && (
                  <div className="theme-mock-sidebar w-1/3 border-r border-border/20 shrink-0">
                    <div className="h-10 border-b border-border/20 px-3 flex items-center">
                      <div className="w-20 h-4 rounded bg-foreground/20" />
                    </div>
                    <div className="p-3">
                      <div className="flex items-center gap-2 p-2 rounded-md bg-foreground/5">
                        <img src="/icon-512x512.png" className="w-8 h-8 rounded-full object-cover" alt="Sylva" />
                        <div className="flex-1">
                          <div className="h-3 w-16 rounded bg-foreground/30 mb-1" />
                          <div className="h-2 w-24 rounded bg-foreground/20" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="theme-mock-header h-12 border-b border-border flex items-center px-3 gap-3 shrink-0">
                    <img src="/icon-512x512.png" className="w-8 h-8 rounded-full object-cover shadow-sm" alt="Sylva" />
                    <div className="font-semibold text-sm drop-shadow-sm mix-blend-luminosity">Sylva</div>
                  </div>
                  
                  <div className="flex-1 p-3 flex flex-col gap-3 justify-end overflow-hidden">
                    <div className="bubble-received self-start max-w-[80%] p-2.5 rounded-2xl rounded-bl-sm text-xs shadow-sm">
                      Hi there! How do you like this theme?
                    </div>
                    
                    <div className="bubble-sent self-end max-w-[80%] p-2.5 rounded-2xl rounded-br-sm text-xs shadow-sm">
                      It looks fantastic! The colors are great.
                    </div>
                    
                    <div className="bubble-received self-start max-w-[80%] p-2.5 rounded-2xl rounded-bl-sm text-xs shadow-sm">
                      And it has glassmorphism!
                    </div>
                  </div>
                  
                  <div className="theme-mock-header p-3 border-t border-border shrink-0">
                    <div className="flex items-center gap-2 bg-background/50 rounded-full border border-border px-3 py-1.5 backdrop-blur-sm">
                      <div className="flex-1 text-xs text-muted-foreground">Type a message...</div>
                      <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                        <Send className="w-3 h-3 text-primary-foreground" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="w-full md:w-7/12 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Theme Name <span className="text-destructive">*</span></Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Olive Dusk" />
              </div>
              <div className="space-y-2">
                <Label>Mode <span className="text-destructive">*</span></Label>
                <select className="w-full h-10 px-3 border border-border bg-card rounded-md shadow-sm" value={mode} onChange={e => setMode(e.target.value as 'light'|'dark')}>
                  <option value="dark">Dark Mode</option>
                  <option value="light">Light Mode</option>
                </select>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Description <span className="text-destructive">*</span></Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="A short description about your theme..." />
            </div>
            
            <div className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border border-border">
              <Label>Make Public</Label>
              <input 
                type="checkbox" 
                checked={isPublic} 
                onChange={e => setIsPublic(e.target.checked)} 
                className="w-5 h-5 accent-primary rounded cursor-pointer" 
              />
            </div>
            
            <div className="space-y-3">
              <Label>Background</Label>
              <div className="w-full border border-border rounded-lg bg-card overflow-hidden">
                <div className="w-full grid grid-cols-2 bg-muted/50 p-1 border-b border-border">
                  <button 
                    className={`py-1.5 text-sm font-medium rounded-md transition-colors ${bgType === 'color' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setBgType('color')}
                  >
                    Solid Color
                  </button>
                  <button 
                    className={`py-1.5 text-sm font-medium rounded-md transition-colors ${bgType === 'image' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setBgType('image')}
                  >
                    Image
                  </button>
                </div>
                
                {bgType === 'color' && (
                  <div className="p-4 flex justify-center">
                    <ColorPickerCircle value={bgColor} onChange={setBgColor} label="Background" />
                  </div>
                )}
                
                {bgType === 'image' && (
                  <div className="p-4">
                    <div 
                      className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-3 transition-colors ${isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'} ${bgImage ? 'py-4' : 'py-8'}`}
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Input type="file" accept="image/*" ref={fileInputRef} onChange={handleImageChange} className="hidden" />
                      {bgImage ? (
                        <div className="relative group">
                          <img src={bgImage} alt="bg preview" className="w-32 h-32 object-cover rounded-md border border-border shadow-sm" />
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-md flex items-center justify-center text-white text-xs cursor-pointer">
                            Change
                          </div>
                          <button 
                            type="button" 
                            onClick={(e) => { e.stopPropagation(); setBgImage(undefined); setBgType('color'); }} 
                            className="absolute -top-2 -right-2 bg-destructive text-white rounded-full w-6 h-6 flex items-center justify-center shadow-md hover:scale-105 transition-transform"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <>
                          <UploadCloud className="w-8 h-8 text-muted-foreground" />
                          <div className="text-center cursor-pointer">
                            <p className="text-sm font-medium">Click or drag and drop</p>
                            <p className="text-xs text-muted-foreground mt-1">SVG, PNG, JPG or GIF</p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            <div className="space-y-3">
              <Label>Component Colors</Label>
              <div className="flex flex-wrap gap-4 p-4 bg-muted/20 rounded-xl border border-border justify-start">
                <ColorPickerCircle value={msgColor} onChange={setMsgColor} label="Sent Bubble" />
                <ColorPickerCircle value={recvColor} onChange={setRecvColor} label="Received Bubble" />
                <ColorPickerCircle value={sendColor} onChange={setSendColor} label="Send Button" />
                <ColorPickerCircle value={headerColor} onChange={setHeaderColor} label="Header" />
                <ColorPickerCircle value={sidebarColor} onChange={setSidebarColor} label="Sidebar" />
                <ColorPickerCircle value={cardColor} onChange={setCardColor} label="Cards / UI" />
              </div>
            </div>

            <div className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border border-border">
              <div className="space-y-0.5">
                <Label>Glassmorphism Bubbles</Label>
                <p className="text-[10px] text-muted-foreground">Applies a frosted glass effect to all message bubbles.</p>
              </div>
              <input 
                type="checkbox" 
                checked={glassmorphism} 
                onChange={e => setGlassmorphism(e.target.checked)} 
                className="w-5 h-5 accent-primary rounded cursor-pointer" 
              />
            </div>

            <div className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border border-border">
              <div className="space-y-0.5">
                <Label>Glassmorphism UI</Label>
                <p className="text-[10px] text-muted-foreground">Applies a frosted glass effect to Sidebar, Header, Cards, and other UI components.</p>
              </div>
              <input 
                type="checkbox" 
                checked={glassmorphismUi} 
                onChange={e => setGlassmorphismUi(e.target.checked)} 
                className="w-5 h-5 accent-primary rounded cursor-pointer" 
              />
            </div>
            
            <div className="space-y-2">
              <Label>Font Family</Label>
              <select className="w-full h-10 px-3 border border-border bg-card rounded-md shadow-sm" value={font} onChange={e => setFont(e.target.value)}>
                <option value="Inter">Inter (Default)</option>
                <option value="system-ui">System Default</option>
                <option value="monospace">Monospace</option>
                <option value="serif">Serif</option>
                <option value="Comic Sans MS">Comic Sans</option>
              </select>
            </div>
          </div>
        </div>
        
        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => handleSave(true)}>
            Save Draft
          </Button>
          <Button onClick={() => handleSave(false)}>
            {isPublic ? 'Publish' : 'Save Theme'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
