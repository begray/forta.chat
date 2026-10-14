importScripts('./js/transports2/fetch/receiver.js');
importScripts('./js/broadcaster.js');

const swBroadcaster = new Broadcaster('ServiceWorker');

const swArgs = new URL(location).searchParams;
const isElectron = (swArgs.get('platform') === 'electron');
const isCapacitor = (swArgs.get('platform') === 'capacitor');

let nodeFetch = (...args) => fetch(...args);

const networkTotalStats = {
  totalTorBytes: 0,
  torSuccessCount: 0,
  directSuccessCount: 0,
  torFailCount: 0,
  directFailCount: 0,
  torBytes: 0,
  directBytes: 0,
};

if (isElectron) {
  nodeFetch = FetchReceiver.init('ExtendedFetch');
}

/**
 * Size of a response body for the network stats, without holding the
 * response back: the page gets the response as soon as the headers arrive and
 * reads the body (and its download progress) itself. Content-Length when the
 * server sends it; otherwise a clone is counted chunk by chunk in the
 * background. Never rejects — a body the page aborts counts what arrived.
 */
async function countResponseBytes(response) {
  const length = Number(response.headers.get('content-length'));
  if (length > 0) return length;

  const body = response.clone().body;
  if (!body) return 0;

  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
  } catch {
    // Aborted or failed mid-body: report what arrived.
  }
  return total;
}

function onFetch(event) {
  const { request } = event;

  const isHttps = request.url.startsWith('https://');
  const isHttp = request.url.startsWith('http://');
  const isProtocolSupported = (isHttps || isHttp);

  if (!isProtocolSupported) {
    return;
  }

  if (isCapacitor && request.destination === 'document') {
    return;
  }

  if (isCapacitor && request.url.includes('https://localhost')) {
    return;
  }

  // The page already asked the Tor routing about this upload and was told
  // "direct" (src/shared/lib/transport/direct-upload.ts): leave it to the
  // network. Answering it here hides the XMLHttpRequest's upload progress.
  if (request.method === 'POST' && new URL(request.url).searchParams.has('forta_direct')) {
    return;
  }

  async function torAnswerElectron() {
    if (!nodeFetch) {
      return;
    }

    const isTorRequest = await swBroadcaster.invoke('AltTransportActive', request.url);

    if (isTorRequest) {
      return await nodeFetch(request)
        .then((response) => {
          const proxyTransportHeader = response.headers.get('#bastyon-proxy-transport');
          const hasUsedTor = (proxyTransportHeader === 'tor');

          countResponseBytes(response).then((bytesLength) => {
            if (hasUsedTor) {
              networkTotalStats.torSuccessCount++;
              networkTotalStats.totalTorBytes += bytesLength;
            } else {
              networkTotalStats.directSuccessCount++;
              networkTotalStats.directBytes += bytesLength;
            }

            swBroadcaster.send('network-stats', {
              status: 'success',
              url: request.url,
              torUsed: hasUsedTor,
              bytesLength,
              totalStats: networkTotalStats,
            });
          });

          return response;
        })
        .catch((err) => {
          networkTotalStats.torFailCount++;

          swBroadcaster.send('network-stats', {
            status: 'failed',
            reason: err,
            url: request.url,
            torUsed: true,
            totalStats: networkTotalStats,
          });

          throw err;
        });
    }
  }

  async function torAnswerCapacitor() {
    const isTorRequest = await swBroadcaster.invoke('AltTransportActive', request.url);

    if (!isTorRequest) {
      return;
    }

    const proxyURL = `http://127.0.0.1:8181/${encodeURIComponent(request.url)}`;
    const fetchInit = {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      credentials: 'omit',
      mode: 'cors',
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // request.body is a ReadableStream, and Chrome rejects a stream body
      // without `duplex` — every Tor-routed POST/PUT failed that way. Send the
      // bytes rather than a streamed upload to the local HTTP/1.1 proxy.
      fetchInit.body = await request.arrayBuffer();
    }

    return fetch(proxyURL, fetchInit)
      .then((response) => {
        countResponseBytes(response).then((bytesLength) => {
          networkTotalStats.torSuccessCount++;
          networkTotalStats.totalTorBytes += bytesLength;

          swBroadcaster.send('network-stats', {
            status: 'success',
            url: request.url,
            torUsed: true,
            bytesLength,
            totalStats: networkTotalStats,
          });
        });

        return response;
      })
      .catch((err) => {
        networkTotalStats.torFailCount++;

        swBroadcaster.send('network-stats', {
          status: 'failed',
          reason: err,
          url: request.url,
          torUsed: true,
          totalStats: networkTotalStats,
        });

        throw err;
      });
  }

  const handle = () => new Promise(async (resolve, reject) => {
    if (isElectron) {
      try {
        const torResponse = await torAnswerElectron();

        if (torResponse) {
          resolve(torResponse);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
    }

    if (isCapacitor) {
      try {
        const torResponse = await torAnswerCapacitor();

        if (torResponse) {
          resolve(torResponse);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
    }

    try {
      const fetchResponse = await fetch(request);

      if (fetchResponse) {
        // Answer on headers: awaiting the body here held a 17 MB video back
        // from the page until it was fully downloaded — no progress, and the
        // page's 30 s headers deadline fired on every attempt.
        resolve(fetchResponse);

        countResponseBytes(fetchResponse).then((bytesLength) => {
          networkTotalStats.directSuccessCount++;
          networkTotalStats.directBytes += bytesLength;

          swBroadcaster.send('network-stats', {
            status: 'success',
            url: request.url,
            bytesLength,
            totalStats: networkTotalStats,
          });
        });
      }
    } catch (err) {
      networkTotalStats.directFailCount++;

      swBroadcaster.send('network-stats', {
        status: 'failed',
        reason: err,
        url: request.url,
        totalStats: networkTotalStats,
      });

      reject(err);
    }
  });

  event.respondWith(handle());
}

async function onInstall(event) {
  console.log('Service Worker was successfully installed');
  // A flagged direct upload (see onFetch) must skip the worker entirely:
  // even unanswered, a request the worker intercepts reports no upload
  // progress. Static routing (Chromium 123+) sends it straight to the
  // network; older engines keep the fetch-handler pass-through.
  if (typeof event.addRoutes === 'function' && typeof URLPattern === 'function') {
    event.waitUntil(
      event.addRoutes({
        condition: { urlPattern: new URLPattern({ search: '*forta_direct=1*' }) },
        source: 'network',
      }).catch((err) => console.warn('Service Worker static route failed:', err)),
    );
  }
  self.skipWaiting();
}

async function onActivate(event) {
  console.log('Service Worker was successfully activated');
  self.clients.claim();
}

self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('install', event => onInstall(event));
self.addEventListener('fetch', event => onFetch(event));
