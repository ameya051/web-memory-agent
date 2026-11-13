import { afterEach, describe, expect, it } from 'vitest';
import { log } from '@/utils/log';
import { captureLogs } from './helpers';

let logs = captureLogs();
afterEach(() => {
  logs.restore();
  logs = captureLogs();
});

describe('logger', () => {
  it('writes one key=value line per call, skipping undefined and printing null as -', () => {
    log.info('db.query', { op: 'saveAnswer', ms: 142, rows: 1, skipped: undefined, firstTokenMs: null });
    expect(logs.lines).toEqual(['[info] db.query op=saveAnswer ms=142 rows=1 firstTokenMs=-']);
  });

  it('logs user text as its length only, at the top level and nested', () => {
    log.info('tool.call', { text: 'my salary is 90k', input: { query: 'secret plans', url: 'https://a.com/' } });
    expect(logs.lines[0]).toBe('[info] tool.call text="[16 chars]" input={"query":"[12 chars]","url":"https://a.com/"}');
  });

  it('redacts secrets and URL credentials', () => {
    log.warn('cfg', { apiKey: 'sk-123', databaseUrl: 'postgres://u:p@h/db', note: 'see postgres://bob:hunter2@db.host/x' });
    expect(logs.lines[0]).toBe('[warn] cfg apiKey=[redacted] databaseUrl=[redacted] note="see postgres://***@db.host/x"');
  });

  it('logs an error by name, message and code, with its stack only at error level', () => {
    const error = Object.assign(new Error('connect failed for postgres://u:pw@host/db'), { code: 'ECONNREFUSED' });
    log.warn('db.down', { error });
    log.error('db.down', { error });
    expect(logs.lines[0]).toBe('[warn] db.down error=Error message="connect failed for postgres://***@host/db" code=ECONNREFUSED');
    expect(logs.lines[1].split('\n')[0]).toBe(logs.lines[0].replace('[warn]', '[error]'));
    expect(logs.lines[1]).toContain('\n');
    expect(logs.lines[1]).not.toContain('pw@');
  });

  it('clips long values', () => {
    log.info('x', { v: 'a'.repeat(400) });
    expect(logs.lines[0]).toBe(`[info] x v=${'a'.repeat(300)}…`);
  });
});
