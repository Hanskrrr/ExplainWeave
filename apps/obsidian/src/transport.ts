import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Desktop-only HTTP transport: uses Node networking, normal TLS validation, and no redirects. */
export function desktopFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local))) {
      reject(new Error('模型服务地址需要 HTTPS；本机服务可使用 HTTP。')); return;
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      reject(new Error('不支持的模型请求格式。')); return;
    }
    if (init.signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: init.method ?? 'GET', headers,
    });
    const abort = () => request.destroy(new DOMException('已取消', 'AbortError'));
    init.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    request.setTimeout(60000, () => request.destroy(new Error('timeout')));
    request.once('error', error => {
      cleanup();
      reject(error.name === 'AbortError' ? error : new Error('无法连接模型服务，或连接已中断。请检查地址与网络。'));
    });
    request.once('response', response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) {
        response.resume(); response.once('end', cleanup);
        resolve(new Response(null, { status, headers: responseHeaders })); return;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', chunk => { controller.enqueue(new Uint8Array(chunk)); });
          response.once('end', () => { cleanup(); controller.close(); });
          response.once('error', () => {
            cleanup();
            controller.error(init.signal?.aborted ? new DOMException('已取消', 'AbortError') : new Error('模型响应中断，已保留收到的内容。'));
          });
        },
        cancel() { cleanup(); response.destroy(); request.destroy(); },
      });
      resolve(new Response(stream, { status, headers: responseHeaders }));
    });
    request.end(init.body ?? undefined);
  });
}
