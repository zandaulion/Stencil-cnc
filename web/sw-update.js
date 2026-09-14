// Shared worker half of pwa-kit. See ../pwa-kit in this workspace.
const PWA_ACK_GRACE_MS = 4000;
const pwaAcked = new Set();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'sw-update-ack' && event.source) {
    pwaAcked.add(event.source.id);
  }
  if (event.data?.type === 'sw-skip-waiting') self.skipWaiting();
});

async function announceUpdate() {
  const windows = await self.clients.matchAll({ type: 'window' });
  if (!windows.length) return;

  pwaAcked.clear();
  for (const client of windows) client.postMessage({ type: 'sw-updated' });
  await new Promise((resolve) => setTimeout(resolve, PWA_ACK_GRACE_MS));

  const remaining = await self.clients.matchAll({ type: 'window' });
  for (const client of remaining) {
    if (pwaAcked.has(client.id) || typeof client.navigate !== 'function') continue;
    try {
      await client.navigate(client.url);
    } catch {
      // The client closed while the worker was waiting.
    }
  }
}
