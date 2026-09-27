import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { desktopFetch } from './transport';

const servers: Server[] = [];
async function server(handler: RequestListener): Promise<string> {
  const service = createServer(handler);
  servers.push(service);
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(service => new Promise<void>(resolve => {
    service.closeAllConnections(); service.close(() => resolve());
  })));
});

it('streams a desktop response and transmits the configured request', async () => {
  let received = '';
  const url = await server((request, response) => {
    request.on('data', chunk => { received += String(chunk); });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: second\n\n'), 5);
    });
  });
  const response = await desktopFetch(url, { method: 'POST', body: 'request-body' });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
  expect(received).toBe('request-body');
});

it('does not forward credentials across redirects', async () => {
  let destinationCalled = false;
  const destination = await server((_request, response) => { destinationCalled = true; response.end(); });
  const url = await server((_request, response) => { response.writeHead(302, { location: destination }); response.end(); });
  const response = await desktopFetch(url, { headers: { authorization: 'Bearer test-secret' } });
  expect(response.status).toBe(302);
  await response.text();
  expect(destinationCalled).toBe(false);
});

it('cancels a response that has already begun streaming', async () => {
  const url = await server((_request, response) => { response.writeHead(200); response.write('first'); });
  const abort = new AbortController();
  const response = await desktopFetch(url, { signal: abort.signal });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  abort.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
});

it('rejects remote plaintext endpoints before making a request', async () => {
  await expect(desktopFetch('http://api.example.test')).rejects.toThrow('HTTPS');
});
