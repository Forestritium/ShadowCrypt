/**
 * Offline outbox queue.
 *
 * Messages that fail to send because the device is offline are stored in
 * IndexedDB. When connectivity returns, the queue is drained and each message
 * is retried through the normal encrypted send path.
 */

import { getDB } from './localStore';
import type { ReplyTo } from '@/types/types';

const STORE = 'outbox';

export interface OutboxItem {
  id: string;
  conversationId: string;
  recipientId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  recipientPublicKey: string;
  createdAt: number;
  imageAttachment?: { storagePath: string; imageKeyBase64: string };
  voiceAttachment?: { storagePath: string; voiceKeyBase64: string; voiceDuration: number };
  fileAttachment?: { storagePath: string; fileKeyBase64: string; fileName: string; fileSize: number; fileMimeType: string };
  replyTo?: ReplyTo | null;
  isViewOnce?: boolean;
  ttlSeconds?: number | null;
}

export async function queueMessage(item: OutboxItem): Promise<void> {
  const db = await getDB();
  await db.put(STORE, item);
}

export async function dequeueMessage(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, id);
}

export async function getPendingMessages(): Promise<OutboxItem[]> {
  const db = await getDB();
  return db.getAll(STORE);
}

export async function clearOutbox(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE, 'readwrite');
  await tx.store.clear();
}

/** True if the error looks like a network / offline failure. */
export function isOfflineError(error: unknown): boolean {
  const msg = (error as Error)?.message?.toLowerCase() ?? '';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('offline') || msg.includes('failed to fetch')) return true;
  return !navigator.onLine;
}
