import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Clock, Plus, Edit, Trash2, Search, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useTheme } from '@/contexts/ThemeContext';
import { CustomThemeEditor } from '@/components/themes/CustomThemeEditor';
import { getCustomThemes, deleteCustomTheme, saveCustomTheme, type CustomTheme } from '@/lib/customThemesStore';
import { supabase } from '@/db/supabase';

export default function ThemesPage() {
  const navigate = useNavigate();
  const { theme: currentTheme, setTheme, autoSchedule, setAutoSchedule } = useTheme();

  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | undefined>(undefined);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [publicThemes, setPublicThemes] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'light' | 'dark'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'az' | 'za' | 'downloads' | 'rating'>('downloads');

  const loadCustomThemes = async () => {
    const themes = await getCustomThemes();
    setCustomThemes(themes);
  };

  const fetchPublicThemes = async (query: string = '', mode: string, sort: string) => {
    setIsSearching(true);
    try {
      let req = supabase.from('public_themes').select('*');
      
      if (query.trim()) {
        req = req.ilike('name', `%${query.trim()}%`);
      }
      if (mode !== 'all') {
        req = req.eq('mode', mode);
      }
      
      switch (sort) {
        case 'newest': req = req.order('created_at', { ascending: false }); break;
        case 'oldest': req = req.order('created_at', { ascending: true }); break;
        case 'az': req = req.order('name', { ascending: true }); break;
        case 'za': req = req.order('name', { ascending: false }); break;
        case 'downloads': req = req.order('downloads', { ascending: false }); break;
        case 'rating': req = req.order('rating_sum', { ascending: false }); break; // Simplified rating sort
      }
      
      req = req.limit(30);

      const { data, error } = await req;
      if (!error && data) {
        setPublicThemes(data.map((d: any) => ({
          id: `public_${d.id}`,
          name: d.name,
          description: d.description,
          mode: d.mode,
          isPublic: true,
          status: 'saved',
          config: d.config,
          downloads: d.downloads,
          rating_sum: d.rating_sum,
          rating_count: d.rating_count
        })));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSearching(false);
    }
  };

  useEffect(() => {
    loadCustomThemes();
    fetchPublicThemes('', filterMode, sortBy);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchPublicThemes(searchQuery, filterMode, sortBy);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchQuery, filterMode, sortBy]);

  const handleRateTheme = async (id: string, rating: number) => {
    const realId = id.replace('public_', '');
    const { error } = await supabase.rpc('rate_theme', { p_theme_id: realId, p_rating: rating });
    if (!error) {
      alert('Thanks for rating!');
      fetchPublicThemes(searchQuery, filterMode, sortBy);
    } else {
      alert('Please log in to rate themes.');
    }
  };

  const handleSelectTheme = (theme: string) => {
    setTheme(theme as any);
  };

  const handleEditCustomTheme = (t: CustomTheme) => {
    setEditingTheme(t);
    setEditorOpen(true);
  };

  const handleDeleteCustomTheme = async (id: string) => {
    if (confirm("Are you sure you want to delete this theme?")) {
      await deleteCustomTheme(id);
      if (currentTheme === id) {
        setTheme('light');
      }
      loadCustomThemes();
    }
  };

  const handleInstallPublicTheme = async (t: CustomTheme) => {
    // Check if already installed
    if (customThemes.some(ct => ct.id === t.id)) {
      alert("Theme is already installed!");
      return;
    }
    await saveCustomTheme(t);
    await loadCustomThemes();
    if (t.id.startsWith('public_')) {
      await supabase.rpc('increment_theme_downloads', { theme_id: t.id.replace('public_', '') });
    }
    alert(`Installed ${t.name}! You can now apply it.`);
  };

  const filteredPublicThemes = publicThemes.filter(t => 
    !customThemes.some(ct => ct.id === t.id) // Don't show if already installed
  );

  const themes = [
    { id: 'light', name: 'Light (Default)', previewBg: 'bg-white', previewBorder: 'border-gray-200' },
    { id: 'dark', name: 'Dark (Default)', previewBg: 'bg-zinc-900', previewBorder: 'border-zinc-800' },
    { id: 'mint', name: 'Mint', previewBg: 'bg-slate-50', previewBorder: 'border-teal-200' },
    { id: 'mint-dark', name: 'Olive Dusk', previewBg: 'bg-slate-900', previewBorder: 'border-teal-800' },
    { id: 'ember', name: 'Ember', previewBg: 'bg-[#141211]', previewBorder: 'border-[#352b27]' },
    { id: 'neon-noir', name: 'Neon Noir', previewBg: 'bg-[#0d0d0d]', previewBorder: 'border-[#00e5ff]' }
  ];

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 p-4 border-b border-border bg-card">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-full shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-semibold">Themes</h1>
      </header>

      <main className="flex-1 p-4 max-w-lg mx-auto w-full space-y-6">
        <p className="text-sm text-muted-foreground">
          Select a theme to customize the appearance of the application.
        </p>

        <div className="grid grid-cols-2 gap-4">
          {themes.map(t => (
            <button
              key={t.id}
              onClick={() => handleSelectTheme(t.id)}
              className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                currentTheme === t.id ? 'border-primary bg-primary/5' : 'border-transparent bg-card hover:bg-muted/50'
              }`}
            >
              <div className={`w-full aspect-video rounded-md border ${t.previewBg} ${t.previewBorder} flex items-center justify-center relative overflow-hidden shadow-sm`}>
                <div className="absolute top-2 left-2 w-1/2 h-3 rounded-full bg-muted/50" />
                <div className="absolute top-6 right-2 w-1/2 h-3 rounded-full bg-primary/50" />
                {currentTheme === t.id && (
                  <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                    <Check className="w-8 h-8 text-primary" />
                  </div>
                )}
              </div>
              <span className="text-sm font-medium">{t.name}</span>
            </button>
          ))}
        </div>

        <div className="pt-6 border-t border-border space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Custom Themes</h2>
              <p className="text-xs text-muted-foreground">Create and share your own themes.</p>
            </div>
            <Button onClick={() => { setEditingTheme(undefined); setEditorOpen(true); }} size="sm" className="gap-1">
              <Plus className="w-4 h-4" /> New
            </Button>
          </div>

          {customThemes.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground bg-muted/30 rounded-xl border border-dashed border-border">
              No custom themes yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {customThemes.map(ct => (
                <div key={ct.id} className={`flex items-center justify-between p-3 rounded-xl border-2 transition-all ${currentTheme === ct.id ? 'border-primary bg-primary/5' : 'border-border bg-card'}`}>
                  <div className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer" onClick={() => { if (ct.status === 'saved') handleSelectTheme(ct.id); }}>
                    <div className="w-10 h-10 rounded-full border shadow-sm shrink-0 flex items-center justify-center overflow-hidden" style={{ backgroundColor: ct.config.backgroundColor }}>
                      {currentTheme === ct.id && <Check className="w-5 h-5 text-primary drop-shadow-md" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate flex items-center gap-2">
                        {ct.name}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${ct.status === 'draft' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20' : 'bg-green-500/10 text-green-500 border-green-500/20'}`}>
                          {ct.status === 'draft' ? 'Draft' : ct.isPublic ? 'Public' : 'Private'}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        Font: {ct.config.fontFamily}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleEditCustomTheme(ct); }}>
                      <Edit className="w-4 h-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDeleteCustomTheme(ct.id); }}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Search Public Themes ───────────────────────────────────── */}
        <div className="pt-6 border-t border-border space-y-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Search className="w-5 h-5" /> Search Public Themes
            </h2>
            <p className="text-xs text-muted-foreground mt-1">Discover themes created by the community.</p>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-3">
            <Input 
              placeholder="Search themes..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-card flex-1"
            />
            <select 
              className="h-10 px-3 border border-border bg-card rounded-md text-sm"
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value as any)}
            >
              <option value="all">All Modes</option>
              <option value="light">Light Mode</option>
              <option value="dark">Dark Mode</option>
            </select>
            <select 
              className="h-10 px-3 border border-border bg-card rounded-md text-sm"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="newest">Recently added</option>
              <option value="oldest">Oldest</option>
              <option value="az">A-Z</option>
              <option value="za">Z-A</option>
              <option value="downloads">Most used</option>
              <option value="rating">Top rated</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 mt-4">
            {isSearching ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                Searching...
              </div>
            ) : filteredPublicThemes.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No public themes found.
              </div>
            ) : (
              filteredPublicThemes.map(pt => (
                <div key={pt.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl border border-border bg-card gap-3">
                  <div className="flex-1 min-w-0 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full border shadow-sm shrink-0" style={{ backgroundColor: pt.config.backgroundColor }} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2">
                        <span className="truncate">{pt.name}</span>
                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded capitalize">{pt.mode}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate mb-1">
                        {pt.description || 'No description'}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>{pt.downloads || 0} downloads</span>
                        <span className="flex items-center gap-0.5">
                          ⭐ {(pt.rating_count ? (pt.rating_sum / pt.rating_count).toFixed(1) : 'New')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <div className="flex gap-0.5 mr-2">
                      {[1,2,3,4,5].map(star => (
                        <button key={star} onClick={() => handleRateTheme(pt.id, star)} className="text-muted-foreground hover:text-yellow-500 text-xs transition-colors">
                          ★
                        </button>
                      ))}
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => handleInstallPublicTheme(pt)} className="gap-1 text-xs h-8">
                      <Download className="w-3.5 h-3.5" /> Install
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Theme auto-scheduling ───────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold">Auto-Scheduling</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Automatically switch between a light theme during the day and a dark theme at night.
          </p>

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="auto-schedule" className="text-sm font-medium">Enable auto-scheduling</Label>
            <input
              id="auto-schedule"
              type="checkbox"
              checked={autoSchedule.enabled}
              onChange={e => setAutoSchedule({ ...autoSchedule, enabled: e.target.checked })}
              className="w-5 h-5 accent-primary rounded border-border bg-muted"
            />
          </div>

          {autoSchedule.enabled && (
            <div className="space-y-4 pt-2 border-t border-border">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="light-start" className="text-xs text-muted-foreground">Light theme starts</Label>
                  <input
                    id="light-start"
                    type="time"
                    value={autoSchedule.lightStart}
                    onChange={e => setAutoSchedule({ ...autoSchedule, lightStart: e.target.value })}
                    className="w-full px-2 py-2 text-sm bg-muted border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dark-start" className="text-xs text-muted-foreground">Dark theme starts</Label>
                  <input
                    id="dark-start"
                    type="time"
                    value={autoSchedule.darkStart}
                    onChange={e => setAutoSchedule({ ...autoSchedule, darkStart: e.target.value })}
                    className="w-full px-2 py-2 text-sm bg-muted border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Day theme</Label>
                  <select
                    value={autoSchedule.lightTheme}
                    onChange={e => setAutoSchedule({ ...autoSchedule, lightTheme: e.target.value as any })}
                    className="w-full px-2 py-2 text-sm bg-muted border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {themes.filter(t => !['dark', 'mint-dark', 'ember', 'neon-noir'].includes(t.id)).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Night theme</Label>
                  <select
                    value={autoSchedule.darkTheme}
                    onChange={e => setAutoSchedule({ ...autoSchedule, darkTheme: e.target.value as any })}
                    className="w-full px-2 py-2 text-sm bg-muted border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {themes.filter(t => ['dark', 'mint-dark', 'ember', 'neon-noir'].includes(t.id)).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {editorOpen && (
        <CustomThemeEditor
          open={editorOpen}
          onClose={() => { setEditorOpen(false); loadCustomThemes(); }}
          initialTheme={editingTheme}
          onSave={loadCustomThemes}
        />
      )}
    </div>
  );
}
