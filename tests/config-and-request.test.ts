import { describe, expect, it } from 'vitest';
import { parseChatRequest } from '@/core/agent/request';
import { loadConfig } from '@/app/config';

describe('config', () => {
  it('names every missing key, treating blank values as missing', () => {
    expect(loadConfig({ EXA_API_KEY: '  ' })).toEqual({
      ok: false,
      missing: ['OPENROUTER_API_KEY', 'EXA_API_KEY', 'DATABASE_URL'],
    });
  });

  it('defaults the main model', () => {
    const result = loadConfig({ OPENROUTER_API_KEY: 'a', EXA_API_KEY: 'b', DATABASE_URL: 'c', MODEL_MAIN: '' });
    expect(result).toEqual({
      ok: true,
      config: { OPENROUTER_API_KEY: 'a', EXA_API_KEY: 'b', DATABASE_URL: 'c', MODEL_MAIN: 'anthropic/claude-sonnet-5.5' },
    });
  });
});

describe('chat request', () => {
  const conversationId = '0b7c2f0e-6a43-4d1e-9a51-3c1f1e2a9b10';
  const body = (text: string, timezone?: string) => ({
    conversationId,
    message: { id: '5d1f7a52-2c6e-4b8f-8f0e-0a6b2c4d9e11', text },
    timezone,
  });

  it('accepts a valid body and keeps a valid timezone', () => {
    const result = parseChatRequest(body('hi', 'Asia/Kolkata'));
    expect(result).toEqual({
      ok: true,
      request: { conversationId, messageId: '5d1f7a52-2c6e-4b8f-8f0e-0a6b2c4d9e11', text: 'hi', timeZone: 'Asia/Kolkata' },
    });
  });

  it('falls back to UTC for an unknown timezone', () => {
    const result = parseChatRequest(body('hi', 'Mars/Olympus'));
    expect(result.ok && result.request.timeZone).toBe('UTC');
  });

  it('rejects an over-long message, an empty one, a non-uuid id and a malformed body', () => {
    expect(parseChatRequest(body('x'.repeat(4001))).ok).toBe(false);
    expect(parseChatRequest(body('   ')).ok).toBe(false);
    expect(parseChatRequest({ ...body('hi'), conversationId: 'c1' }).ok).toBe(false);
    expect(parseChatRequest({ messages: 'nope' }).ok).toBe(false);
    expect(parseChatRequest(null).ok).toBe(false);
  });
});
