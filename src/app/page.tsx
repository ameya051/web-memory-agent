import { ChatPage } from './chat-page';

// Read the config and the thread on every request, not at build time.
export const dynamic = 'force-dynamic';

export default function Page() {
  return <ChatPage conversationId={null} />;
}
