import { openDB } from 'idb';

const DB_NAME = 'sc_custom_themes_db';
const DB_VERSION = 1;
const STORE_NAME = 'themes';

export type CustomTheme = {
  id: string;
  name: string;
  description?: string;
  mode?: 'light' | 'dark';
  isPublic: boolean;
  status: 'draft' | 'saved';
  config: {
    messageBubbleColor: string;
    receivedBubbleColor?: string;
    sendButtonColor: string;
    backgroundColor: string;
    fontFamily: string;
    backgroundImageDataUrl?: string;
    backgroundType?: 'color' | 'image';
    headerColor?: string;
    sidebarColor?: string;
    cardColor?: string;
    glassmorphism?: boolean;
    glassmorphismUi?: boolean;
  };
};

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    },
  });
}

export async function saveCustomTheme(theme: CustomTheme) {
  const db = await getDB();
  await db.put(STORE_NAME, theme);
}

export async function getCustomThemes(): Promise<CustomTheme[]> {
  const db = await getDB();
  return db.getAll(STORE_NAME);
}

export async function getCustomTheme(id: string): Promise<CustomTheme | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

export async function deleteCustomTheme(id: string) {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}
