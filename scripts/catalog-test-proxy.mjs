import http from 'node:http';
import { readFile } from 'node:fs/promises';

const SITE = 'https://lady-elka.ru';
const FEEDS = 'https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/catalog/feeds/';
const PORT = Number(process.env.PORT || 4179);
const snapshotMode = process.argv.includes('--snapshot');
const remoteSnapshotBase = process.env.CATALOG_TEST_SNAPSHOT_BASE?.replace(/\/$/, '');

async function downloadSnapshot(name) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(FEEDS + name);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      console.warn(`Не удалось получить ${name}, попытка ${attempt}/3`);
    }
  }
  throw lastError;
}

const candidateScript = await readFile(new URL('../dist/catalog.js', import.meta.url));
const snapshots = snapshotMode && !remoteSnapshotBase
  ? Object.fromEntries(await Promise.all(
      ['trees.csv', 'decor.csv'].map(async (name) => [
        name,
        await downloadSnapshot(name),
      ]),
    ))
  : {};

const script = (snapshotMode || remoteSnapshotBase)
  ? Buffer.from(
      candidateScript
        .toString()
        .replaceAll(`${FEEDS}trees.csv`, remoteSnapshotBase ? `${remoteSnapshotBase}/trees.csv` : '/__candidate/trees.csv')
        .replaceAll(`${FEEDS}decor.csv`, remoteSnapshotBase ? `${remoteSnapshotBase}/decor.csv` : '/__candidate/decor.csv'),
    )
  : candidateScript;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, SITE);

  if (url.pathname === '/__candidate/catalog.js') {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    response.end(script);
    return;
  }

  const snapshot = snapshots[url.pathname.slice('/__candidate/'.length)];
  if (snapshot) {
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
    response.end(snapshot);
    return;
  }

  try {
    const upstream = await fetch(SITE + request.url, { headers: { 'accept-encoding': 'identity' } });
    const headers = Object.fromEntries(
      [...upstream.headers].filter(([name]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(name)),
    );
    let body = Buffer.from(await upstream.arrayBuffer());

    if (/^\/catalog(?:[-/]|$)/.test(url.pathname) && /text\/html/i.test(upstream.headers.get('content-type') || '')) {
      body = Buffer.from(body.toString().replace(/\/f\/catalog\.js\?v=\d+/g, '/__candidate/catalog.js'));
    }

    response.writeHead(upstream.status, headers);
    response.end(body);
  } catch (error) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Тестовый каталог: http://127.0.0.1:${PORT}/catalog`);
  console.log(remoteSnapshotBase ? `Режим: внешний статический снимок (${remoteSnapshotBase})` : snapshotMode ? 'Режим: локальный снимок цен' : 'Режим: живые цены Supabase');
});
