import { z } from 'zod';
import { parseTimeZone } from '@/utils/dates';
import type { ChatRequest } from '@/types/agent';

// Shape check and length cap on the chat API body (spec 9.1). The server holds
// the thread, so the browser sends only the new message, under ids it made
// (spec 5.3, R6), and its timezone.

export const MAX_USER_CHARS = 4000;

const bodySchema = z.object({
  conversationId: z.uuid(),
  message: z.object({ id: z.uuid(), text: z.string() }),
  // The browser's IANA timezone; anything unknown falls back to UTC (spec 5.1).
  timezone: z
    .string()
    .optional()
    .transform(parseTimeZone),
});

export function parseChatRequest(
  body: unknown,
): { ok: true; request: ChatRequest } | { ok: false; error: string } {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'Malformed chat request.' };

  const { conversationId, message, timezone } = parsed.data;
  if (message.text.trim() === '') return { ok: false, error: 'The message is empty.' };
  if (message.text.length > MAX_USER_CHARS) {
    return { ok: false, error: `Messages are limited to ${MAX_USER_CHARS} characters.` };
  }

  return { ok: true, request: { conversationId, messageId: message.id, text: message.text, timeZone: timezone } };
}
