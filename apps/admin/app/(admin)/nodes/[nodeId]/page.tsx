import type { Metadata } from 'next';
import { NodePage } from '@/components/fleet/node-page';

export async function generateMetadata({ params }: { params: Promise<{ nodeId: string }> }): Promise<Metadata> {
  const { nodeId } = await params;
  return { title: nodeId.replace(/^n-/, '') };
}

export default async function Page({ params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await params;
  return <NodePage nodeId={decodeURIComponent(nodeId)} />;
}
