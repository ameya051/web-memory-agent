// Response timing (spec 6.4). Times are performance.now() milliseconds: real
// elapsed time, so the dev clock override never affects them.
//
// total:       request start to end of stream
// firstToken:  start to the first streamed text
// streaming:   first to last streamed text
// toolsWall:   time during which at least one tool was running
// toolsSum:    every tool call's duration added together
// model:       total minus toolsWall (includes our own small overhead)

import type { ToolCallTime, Timing } from '@/types/agent';

export function summarizeTiming(t: {
  startedAt: number;
  endedAt: number;
  firstText: number | null;
  lastText: number | null;
  toolCalls: ToolCallTime[];
}): Timing {
  const totalMs = t.endedAt - t.startedAt;
  const toolsWallMs = unionLength(t.toolCalls);
  return {
    totalMs: Math.round(totalMs),
    firstTokenMs: t.firstText === null ? null : Math.round(t.firstText - t.startedAt),
    streamingMs: t.firstText === null || t.lastText === null ? null : Math.round(t.lastText - t.firstText),
    modelMs: Math.round(Math.max(0, totalMs - toolsWallMs)),
    toolsWallMs: Math.round(toolsWallMs),
    toolsSumMs: Math.round(t.toolCalls.reduce((sum, c) => sum + (c.end - c.start), 0)),
    toolCount: t.toolCalls.length,
  };
}

/** Length covered by the union of intervals, so parallel calls count once. */
function unionLength(calls: ToolCallTime[]): number {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const { start, end } of sorted) {
    if (start > curEnd) {
      total += curEnd - curStart > 0 ? curEnd - curStart : 0;
      curStart = start;
      curEnd = end;
    } else {
      curEnd = Math.max(curEnd, end);
    }
  }
  return total + (curEnd - curStart > 0 ? curEnd - curStart : 0);
}
