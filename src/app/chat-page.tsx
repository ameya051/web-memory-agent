import { loadHistory } from '@/services/seed';
import { PendingMigrationsError } from '@/services/store-postgres';
import { toUIMessages } from '@/core/agent/thread';
import { log } from '@/utils/log';
import { Chat } from './chat';
import { configResult } from './config';
import { devEnabled, devView } from './dev';
import { getStore } from './store';

/** The chat UI for one conversation. An id with no rows yet is a new chat; null on `/`. */
export async function ChatPage({ conversationId }: { conversationId: string | null }) {
  if (!configResult.ok) {
    return (
      <main className="setup">
        <h1>Setup needed</h1>
        <p>
          Missing {configResult.missing.map((key, i) => (
            <span key={key}>
              {i > 0 && ', '}
              <code>{key}</code>
            </span>
          ))}
          .
        </p>
        <p>
          Copy <code>.env.example</code> to <code>.env</code>, fill in the keys, and restart <code>npm run dev</code>.
        </p>
      </main>
    );
  }

  try {
    const store = getStore();
    const user = await store.findUser();
    const dev = devEnabled ? { ...devView(configResult.config), demoDay: (await loadHistory()).demoDay } : null;
    const [conversations, thread] = user
      ? await Promise.all([
          store.listConversations(user.id),
          conversationId ? store.loadThread(user.id, conversationId) : null,
        ])
      : [[], null];
    return (
      <Chat
        conversationId={conversationId}
        initialMessages={thread ? toUIMessages(thread.messages, thread.sources, thread.citedSaved) : []}
        conversations={conversations}
        dev={dev}
      />
    );
  } catch (error) {
    log.error('page.load_failed', { error });
    if (error instanceof PendingMigrationsError) {
      return (
        <main className="setup">
          <h1>Database needs migrating</h1>
          <p>
            Run <code>npm run migrate up</code>, then reload. Pending: {error.pending.join(', ')}.
          </p>
        </main>
      );
    }
    return (
      <main className="setup">
        <h1>Database unavailable</h1>
        <p>
          Could not reach the database. Check <code>DATABASE_URL</code> in <code>.env</code> and restart <code>npm run dev</code>.
        </p>
      </main>
    );
  }
}
