import { z } from 'zod';

const id = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const change = z.discriminatedUnion('field', [
  z.object({ field: z.literal('level'), value: z.number().int().min(1).max(9999), evidence: text(10000) }).strict(),
  ...(['location', 'character', 'notes'] as const).map(field =>
    z.object({ field: z.literal(field), value: text(4000), evidence: text(10000) }).strict()),
  ...(['inventory', 'goals'] as const).map(field =>
    z.object({ field: z.literal(field), value: z.array(text(200)).max(100), evidence: text(10000) }).strict()),
]);

export const commands = {
  create_game: z.object({ title: text(200), platform: text(100), game_version: text(100) }).strict(),
  create_profile: z.object({ game_id: id, name: text(200) }).strict(),
  record_message: z.object({ profile_id: id, idempotency_key: id, body: z.string().min(1).max(10000).refine(v => v.trim().length > 0) }).strict(),
  submit_message: z.object({ profile_id: id, idempotency_key: id, body: z.string().min(1).max(10000).refine(v => v.trim().length > 0), expected_revision: revision }).strict(),
  process_message: z.object({ message_id: id, expected_revision: revision }).strict(),
  confirm_progress: z.object({ message_id: id, expected_revision: revision, user_confirmed: z.literal(true), changes: z.array(change).min(1).max(20) }).strict(),
  undo: z.object({ event_id: id, expected_revision: revision }).strict(),
  add_source: z.object({
    game_id: id, title: text(200), game_version: text(100), excerpt: text(50000),
    url: z.url().max(2048).refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    }, 'Use an HTTPS URL without credentials or fragment'),
    retrieved_at: z.iso.datetime({ offset: true }),
  }).strict(),
  add_knowledge: z.object({ source_id: id, claim: text(4000), quote: text(4000) }).strict(),
} as const;

export const querySchema = z.object({
  collection: z.enum(['games', 'profiles', 'messages', 'events', 'sources', 'knowledge']),
  id: id.optional(), game_id: id.optional(), profile_id: id.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();
export type Query = z.infer<typeof querySchema>;
export type Command = keyof typeof commands;
export function isCommand(value: string): value is Command {
  return Object.hasOwn(commands, value);
}
