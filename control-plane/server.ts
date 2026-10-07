import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import control, { errorResponse, type Env } from './index.ts';
import { Store, type Database } from './store.ts';
import { dispatch, recoverStarting } from './dispatch.ts';
import { Fault, capacity, type Capacity } from '../shared/contracts.ts';

type Options = {
  db: Database & {close():void}; authJson: string; limits: Capacity; host: string; port: number;
  scheduleEnabled?: boolean; scheduleIntervalMs?: number; watchAcceptanceEnabled?: boolean;
};

function webRequest(input: IncomingMessage): Request {
  const host = input.headers.host;
  if (!host || /[\s/@\\?#]/.test(host)) throw new Fault(403,'localhost_only');
  const url = new URL('http://' + host);
  if (!input.url?.startsWith('/') || input.url.startsWith('//')) throw new Fault(400,'invalid_request_target');
  url.pathname = input.url.split('?')[0];
  url.search = input.url.includes('?') ? input.url.slice(input.url.indexOf('?')) : '';
  const headers = new Headers();
  for (let i = 0; i < input.rawHeaders.length; i += 2) headers.append(input.rawHeaders[i],input.rawHeaders[i+1]);
  const method = input.method!;
  let body: ReadableStream<Uint8Array> | undefined;
  if (!['GET','HEAD'].includes(method)) {
    input.pause();
    let finished = false;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        input.on('data',(chunk:Buffer) => {if (!finished) controller.enqueue(chunk);input.pause();});
        input.once('end',() => {if (!finished) {finished=true;controller.close();}});
        input.once('error',() => {if (!finished) {finished=true;controller.error(new Fault(400,'incomplete_body'));}});
      },
      pull() { input.resume(); },
      // Cancelling an oversized body must still allow its 413 response to reach the socket.
      cancel() { finished=true;input.pause(); },
    },{highWaterMark:0});
  }
  return new Request(url,{method,headers,...(body ? {body,duplex:'half' as const} : {})});
}

async function respond(input: IncomingMessage, output: ServerResponse, env: Env) {
  let response: Response;
  try { response = await control.fetch(webRequest(input),env); }
  catch (error) { response = errorResponse(error); }
  if (output.destroyed) return;
  output.writeHead(response.status,{...Object.fromEntries(response.headers),...(!input.complete?{connection:'close'}:{})});
  output.end(Buffer.from(await response.arrayBuffer()));
}

export async function startServer(options: Options) {
  const active = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerError: unknown;
  let stopping: Promise<void> | undefined;
  const server = createServer((input,output) => {
    const task = respond(input,output,env);
    active.add(task);
    void task.then(() => active.delete(task), error => {active.delete(task);output.destroy(error instanceof Error?error:new Error('http_response_failed'));});
  });
  const env: Env = {DB:options.db,MODE:'local',AUTH_JSON:options.authJson,LIMITS_JSON:JSON.stringify(options.limits),WATCH_ACCEPTANCE_ENABLED:String(options.watchAcceptanceEnabled === true)};
  try {
    if (!['127.0.0.1','::1'].includes(options.host)) throw new Error('loopback_listen_required');
    capacity(options.limits);
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('invalid_port');
    const interval = options.scheduleIntervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('invalid_schedule_interval');
    await recoverStarting(new Store(options.db));
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject);
      server.listen(options.port,options.host,() => {server.off('error',reject);resolve();});
    });
    if (options.scheduleEnabled === true) timer = setInterval(() => {
      const task = dispatch(new Store(options.db),Date.now());
      active.add(task);
      void task.then(() => active.delete(task), error => {
        active.delete(task);timerError=error;clearInterval(timer);
        process.stderr.write('local_schedule_failed\n');
      });
    },interval);
  } catch (error) { options.db.close(); throw error; }
  const address = server.address() as AddressInfo;
  return {
    url:'http://' + (address.family === 'IPv6' ? '['+address.address+']' : address.address) + ':'+address.port,
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        const closed = new Promise<void>((resolve,reject) => server.close(error => error?reject(error):resolve()));
        clearInterval(timer);
        try { await closed; await Promise.allSettled([...active]); }
        finally { options.db.close(); }
        if (timerError !== undefined) throw timerError;
      })();
      return stopping;
    },
  };
}
