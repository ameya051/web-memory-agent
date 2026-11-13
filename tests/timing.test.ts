import { describe, expect, it } from 'vitest';
import { summarizeTiming } from '@/core/agent/timing';

const call = (start: number, end: number) => ({ name: 'web_search', start, end, ok: true });

describe('response timing', () => {
  it('counts parallel tool calls once in wall time and fully in the sum', () => {
    const t = summarizeTiming({
      startedAt: 0,
      endedAt: 5000,
      firstText: 3000,
      lastText: 4500,
      // Two overlapping calls (1000–2000, 1500–2500), then a separate one (3000–3200).
      toolCalls: [call(1000, 2000), call(1500, 2500), call(3000, 3200)],
    });
    expect(t).toEqual({
      totalMs: 5000,
      firstTokenMs: 3000,
      streamingMs: 1500,
      modelMs: 5000 - 1700,
      toolsWallMs: 1700,
      toolsSumMs: 2200,
      toolCount: 3,
    });
  });

});
