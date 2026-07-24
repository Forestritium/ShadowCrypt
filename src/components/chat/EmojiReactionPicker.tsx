/**
 * EmojiReactionPicker — full emoji picker with categories and search.
 * Replaces the previous 8-emoji limited bar with a comprehensive grid.
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Smile, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { getFrequentEmojis, addFrequentEmoji } from '@/lib/emojiStore';

// Keyword map for emoji search.  Missing entries still match by category label
// or by typing the emoji character directly.
const EMOJI_KEYWORDS: Record<string, string[]> = {
  '👍': ['thumbs', 'up', 'like', 'good', 'yes', 'approve'],
  '❤️': ['heart', 'love', 'like', 'red'],
  '😂': ['joy', 'laugh', 'tears', 'funny', 'haha'],
  '😮': ['wow', 'surprise', 'shocked', 'amazed', 'open', 'mouth'],
  '😢': ['cry', 'sad', 'tear'],
  '🔥': ['fire', 'hot', 'lit', 'burn'],
  '👏': ['clap', 'applause', 'praise'],
  '🎉': ['party', 'celebrate', 'congrats', 'tada'],
  '🙏': ['pray', 'please', 'thanks', 'gratitude'],
  '💯': ['hundred', '100', 'perfect', 'score'],
  '✅': ['check', 'done', 'complete', 'yes'],
  '🚀': ['rocket', 'launch', 'boost'],
  '😀': ['grin', 'smile', 'happy'],
  '😃': ['smile', 'happy', 'grin'],
  '😄': ['smile', 'happy', 'joy'],
  '😁': ['beam', 'grin', 'smile'],
  '😆': ['laugh', 'smile', 'xd'],
  '😅': ['sweat', 'smile', 'nervous'],
  '🤣': ['rofl', 'laugh', 'funny'],
  '🙂': ['slight', 'smile'],
  '🙃': ['upside', 'down', 'silly'],
  '😉': ['wink', 'flirt'],
  '😊': ['blush', 'smile', 'happy'],
  '😇': ['angel', 'halo', 'innocent'],
  '🥰': ['love', 'smile', 'hearts'],
  '😍': ['heart', 'eyes', 'love'],
  '🤩': ['star', 'eyes', 'amazed'],
  '😘': ['kiss', 'love'],
  '😗': ['kiss'],
  '😚': ['kiss', 'love'],
  '😙': ['kiss', 'smile'],
  '🥲': ['tear', 'smile', 'grateful'],
  '😋': ['yum', 'tongue', 'food'],
  '😛': ['tongue', 'silly'],
  '😜': ['wink', 'tongue', 'playful'],
  '🤪': ['zany', 'crazy', 'silly'],
  '😝': ['tongue', 'laugh'],
  '🤑': ['money', 'tongue', 'rich'],
  '🤗': ['hug', 'excited'],
  '🤭': ['giggle', 'oops', 'hand', 'mouth'],
  '🫢': ['gasp', 'shock'],
  '🫣': ['peek', 'shy', 'hide'],
  '🤫': ['shush', 'quiet'],
  '🤔': ['think', 'hmm'],
  '🫡': ['salute', 'respect'],
  '🤐': ['zip', 'quiet', 'secret'],
  '🤨': ['suspicious', 'raised', 'eyebrow'],
  '😐': ['neutral', 'meh'],
  '😑': ['expressionless', 'meh'],
  '😶': ['silent', 'quiet'],
  '🫥': ['dotted', 'face', 'hidden'],
  '😏': ['smirk', 'sly'],
  '😒': ['unamused', 'annoyed'],
  '🙄': ['eyeroll', 'eye', 'disbelief'],
  '😬': ['grimace', 'awkward'],
  '🤥': ['lie', 'liar', 'nose'],
  '😌': ['relieved', 'calm'],
  '😔': ['pensive', 'sad'],
  '😪': ['sleepy', 'tired'],
  '🤤': ['drool', 'sleepy'],
  '😴': ['sleep', 'zzz', 'tired'],
  '😷': ['sick', 'mask', 'covid'],
  '🤒': ['sick', 'fever'],
  '🤕': ['hurt', 'bandage', 'injured'],
  '🤢': ['nausea', 'sick'],
  '🤮': ['vomit', 'sick', 'throw', 'up'],
  '🤧': ['sneeze', 'sick'],
  '🥵': ['hot', 'sweat', 'heat'],
  '🥶': ['cold', 'freeze', 'ice'],
  '🥴': ['woozy', 'dizzy', 'drunk'],
  '😵': ['dizzy', 'knockout'],
  '🤯': ['mind', 'blown', 'explode'],
  '🤠': ['cowboy', 'hat'],
  '🥳': ['party', 'celebrate', 'hat'],
  '🥸': ['disguise', 'glasses', 'mustache'],
  '😎': ['cool', 'sunglasses'],
  '🤓': ['nerd', 'glasses'],
  '🧐': ['monocle', 'inspect'],
  '😕': ['confused', 'uncertain'],
  '🫤': ['diagonal', 'mouth', 'meh'],
  '😟': ['worried', 'concerned'],
  '🙁': ['frown', 'sad'],
  '☹️': ['frown', 'sad'],
  '😯': ['hushed', 'surprise'],
  '😲': ['astonished', 'shock'],
  '😳': ['flushed', 'embarrassed'],
  '🥺': ['pleading', 'puppy', 'eyes'],
  '🫹': ['palm', 'right', 'wave'],
  '😦': ['frown', 'surprise'],
  '😧': ['anguished', 'pain'],
  '😨': ['fearful', 'scared'],
  '😰': ['anxious', 'sweat', 'nervous'],
  '😥': ['sad', 'relieved'],
  '😭': ['sob', 'cry', 'loudly'],
  '😱': ['scream', 'fear'],
  '😖': ['confounded', 'pain'],
  '😣': ['persevere', 'pain'],
  '😞': ['disappointed', 'sad'],
  '😓': ['sweat', 'nervous'],
  '😩': ['weary', 'tired'],
  '😫': ['tired', 'exhausted'],
  '🥱': ['yawn', 'sleepy'],
  '😤': ['huff', 'angry'],
  '😡': ['rage', 'angry', 'mad'],
  '😠': ['angry', 'mad'],
  '🤬': ['cursing', 'swearing', 'angry'],
  '😈': ['devil', 'evil', 'horns'],
  '👿': ['angry', 'devil'],
  '💀': ['skull', 'dead', 'death'],
  '☠️': ['skull', 'crossbones', 'poison'],
  '💩': ['poop', 'poo'],
  '🤡': ['clown'],
  '👹': ['ogre', 'monster'],
  '👺': ['goblin', 'monster'],
  '👻': ['ghost', 'boo'],
  '👽': ['alien'],
  '👾': ['monster', 'space', 'invader'],
  '🤖': ['robot'],
  '👋': ['wave', 'hello', 'hi', 'bye'],
  '🤚': ['raised', 'hand'],
  '🖐️': ['hand', 'fingers'],
  '✋': ['stop', 'hand', 'high', 'five'],
  '🖖': ['vulcan', 'salute'],
  '👌': ['ok', 'perfect'],
  '🤌': ['pinched', 'fingers'],
  '🤏': ['pinch', 'small'],
  '✌️': ['victory', 'peace'],
  '🤞': ['fingers', 'crossed', 'luck'],
  '🤟': ['love', 'you', 'hand'],
  '🤘': ['rock', 'horns'],
  '🤙': ['call', 'phone', 'shaka'],
  '👎': ['thumbs', 'down', 'dislike'],
  '✊': ['fist', 'power'],
  '👊': ['punch', 'fist', 'bro'],
  '🤛': ['left', 'fist'],
  '🤜': ['right', 'fist'],
  '🙌': ['raise', 'celebrate', 'hallelujah'],
  '🫶': ['heart', 'hands', 'love'],
  '👐': ['open', 'hands', 'hug'],
  '🤲': ['palms', 'up', 'together'],
  '🤝': ['handshake', 'deal', 'agree'],
  '💪': ['muscle', 'strong', 'flex'],
  '🧡': ['orange', 'heart', 'love'],
  '💛': ['yellow', 'heart', 'love'],
  '💚': ['green', 'heart', 'love'],
  '💙': ['blue', 'heart', 'love'],
  '💜': ['purple', 'heart', 'love'],
  '🖤': ['black', 'heart', 'love'],
  '🤍': ['white', 'heart', 'love'],
  '🤎': ['brown', 'heart', 'love'],
  '💔': ['broken', 'heart', 'sad'],
  '💕': ['two', 'hearts', 'love'],
  '💞': ['revolving', 'hearts', 'love'],
  '💓': ['beating', 'heart', 'love'],
  '💗': ['growing', 'heart', 'love'],
  '💖': ['sparkle', 'heart', 'love'],
  '💘': ['cupid', 'heart', 'love'],
  '💝': ['gift', 'heart', 'love'],
  '💟': ['heart', 'decoration'],
};

// Full categorised emoji set
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Quick',
    emojis: ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉', '🙏', '💯', '✅', '🚀'],
  },
  {
    label: 'Smileys',
    emojis: [
      '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊',
      '😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜',
      '🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨',
      '😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪',
      '🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵',
      '🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️',
      '😮','😯','😲','😳','🥺','🫹','😦','😧','😨','😰','😥','😢',
      '😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠',
      '🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖',
    ],
  },
  {
    label: 'Gestures',
    emojis: [
      '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏',
      '✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️',
      '🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲',
      '🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃',
    ],
  },
  {
    label: 'Hearts',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹',
      '💔','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️',
    ],
  },
  {
    label: 'Animals',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁',
      '🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆',
      '🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌',
      '🐞','🐜','🪲','🦟','🦗','🪳','🕷️','🦂','🐢','🐍','🦎','🦖',
      '🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋',
      '🦈','🦭','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏',
      '🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑',
    ],
  },
  {
    label: 'Food',
    emojis: [
      '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑',
      '🥭','🍍','🥥','🥝','🍅','🫒','🥑','🍆','🥦','🥬','🥒','🫑',
      '🌽','🌶️','🫚','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🫓',
      '🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔',
      '🍟','🍕','🫔','🌮','🌯','🥙','🧆','🥚','🍿','🧂','🥫','🍱',
      '🍘','🍙','🍚','🍛','🍜','🍝','🍣','🍤','🍙','🥟','🦪','🍦',
      '🍧','🍨','🍰','🎂','🧁','🥧','🍫','🍬','🍭','☕','🫖','🍵',
    ],
  },
  {
    label: 'Activities',
    emojis: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓',
      '🏸','🏒','🥍','🏑','🏏','🪃','🥅','⛳','🪁','🤿','🎣','🤸',
      '🏊','🚴','🤾','🏋️','🤺','⛷️','🏂','🪂','🏇','🤼','🤽','🚵',
      '🎮','🕹️','🎲','🃏','🀄','🎯','🎳','🎰','🧩','🪆','🎭','🎨',
      '🖼️','🎪','🎤','🎧','🎼','🎵','🎶','🎹','🎸','🎺','🎻','🥁',
    ],
  },
  {
    label: 'Travel',
    emojis: [
      '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚',
      '🚛','🚜','🏍️','🛵','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽',
      '🚨','🚥','🚦','✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁',
      '🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','🏖️','🏝️','🌋','🏔️','⛰️',
      '🗻','🏕️','🏜️','🏞️','🌅','🌄','🌠','🎇','🎆','🌃','🌆','🌇',
    ],
  },
  {
    label: 'Objects',
    emojis: [
      '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','💾','💿','📀','📷',
      '📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🧭',
      '⏱️','⏲️','🕰️','⌛','⏳','💡','🔦','🕯️','🪔','🧯','🛢️','💰',
      '🪙','💴','💵','💶','💷','💸','💳','🧾','💹','📈','📉','📊',
      '🔑','🗝️','🔐','🔏','🔒','🔓','🔨','🪓','⛏️','⚒️','🛠️','🔧',
      '🔩','⚙️','🗜️','🔗','⛓️','🪝','🧲','🪜','🧪','🧫','🧬','🔬',
      '🔭','📡','💊','🩺','📎','🖇️','✂️','🗃️','🗄️','🗑️','📦','📫',
    ],
  },
  {
    label: 'Symbols',
    emojis: [
      '🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨',
      '🟩','🟦','🟪','🟫','⬛','⬜','💠','🔷','🔹','🔶','🔸','🔺',
      '🔻','💢','💬','💭','💯','🔞','📵','🚫','🚷','🚯','🚳','🚱',
      '⚠️','☢️','☣️','✅','☑️','🔘','🔲','🔳','▶️','⏩','⏭️','⏯️',
      '#️⃣','*️⃣','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣',
    ],
  },
];

// Flat list for search
const ALL_EMOJIS = EMOJI_CATEGORIES.flatMap(c => c.emojis);

/** Exported helper for unit testing the emoji search filter. */
export function filterEmojisByQuery(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_EMOJIS.filter(e => {
    if (e.includes(q)) return true;
    if (EMOJI_KEYWORDS[e]?.some(k => k.includes(q))) return true;
    const cat = EMOJI_CATEGORIES.find(c => c.emojis.includes(e));
    if (cat && cat.label.toLowerCase().includes(q)) return true;
    return false;
  });
}

interface EmojiReactionPickerProps {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}

export function EmojiReactionPicker({ onSelect, disabled }: EmojiReactionPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
    else setSearch('');
  }, [open]);

  const filteredEmojis = useMemo(() => {
    if (!search.trim()) return null;
    return filterEmojisByQuery(search);
  }, [search]);

  const handleSelect = (emoji: string) => {
    addFrequentEmoji(emoji);
    onSelect(emoji);
    setOpen(false);
  };

  const dynamicCategories = useMemo(() => {
    const freqs = getFrequentEmojis();
    if (freqs.length > 0) {
      return [
        { label: 'Frequent', emojis: freqs },
        ...EMOJI_CATEGORIES
      ];
    }
    return EMOJI_CATEGORIES;
  }, [open]); // recalculate when opened

  const currentCategoryEmojis = filteredEmojis ?? dynamicCategories[activeCategory].emojis;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="shrink-0 self-center w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-muted transition-all duration-150 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Add reaction"
        >
          <Smile className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-72 p-0 overflow-hidden"
      >
        {/* Search */}
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search emoji…"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>

        {/* Category tabs */}
        {!filteredEmojis && (
          <div className="flex gap-0.5 px-1.5 pt-1.5 overflow-x-auto scrollbar-none">
            {dynamicCategories.map((cat, i) => (
              <button
                key={cat.label}
                type="button"
                onClick={() => setActiveCategory(i)}
                className={`px-2 py-1 text-xs rounded-md shrink-0 transition-colors ${
                  activeCategory === i
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        )}

        {/* Emoji grid */}
        <div className="h-52 overflow-y-auto p-1.5">
          <div className="grid grid-cols-9 gap-0.5">
            {currentCategoryEmojis.map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                type="button"
                onClick={() => handleSelect(emoji)}
                className="w-7 h-7 flex items-center justify-center rounded text-base hover:bg-muted transition-colors leading-none"
                aria-label={emoji}
              >
                {emoji}
              </button>
            ))}
            {filteredEmojis?.length === 0 && (
              <div className="col-span-9 py-6 text-center text-xs text-muted-foreground">
                No matching emoji
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { EMOJI_CATEGORIES };
// Keep backward compat for ReactionBar which imports REACTION_EMOJIS
export const REACTION_EMOJIS = EMOJI_CATEGORIES[0].emojis;

