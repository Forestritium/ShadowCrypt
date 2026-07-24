/**
 * Session-only re-exports of relay functions.
 *
 * This wrapper lets session.ts lazy-load relay logic without creating a
 * direct dynamic-import cycle for relay.ts itself.  relay.ts is statically
 * imported by the chat route chunk, so keeping session.ts's usage indirect
 * avoids Vite's "dynamic import will not move module into another chunk" warning.
 */

export { registerDevice } from './relay';
