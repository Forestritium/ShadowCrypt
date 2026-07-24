/**
 * Session-only re-exports of X3DH functions.
 *
 * This wrapper lets session.ts lazy-load X3DH prekey publication without
 * forcing x3dh.ts to be split ambiguously across the main and route chunks.
 */

export { publishPrekeys, replenishOPKsIfNeeded } from './x3dh';
