import { redirect } from 'next/navigation';
import { ChatPage } from '@/app/chat-page';

// Read the config and the thread on every request, not at build time.
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) redirect('/');
  return <ChatPage conversationId={id.toLowerCase()} />;
}
