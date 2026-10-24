// The long-running watcher: one AccountWatcher per account, polled until stopped.

import { runClaude } from './runner.mjs';
import { AccountStore, acquireLock } from './store.mjs';
import { openTransport } from './transport.mjs';
import { buildTriggerRegex } from './trigger.mjs';
import { AccountWatcher } from './watcher.mjs';

// deps: { log, runJob, makeSocket, signal }. Without a signal, SIGTERM and SIGINT stop it.
export async function runService(cfg, deps = {}) {
  const log = deps.log || (() => {});
  const runJob = deps.runJob || runClaude;
  const releaseLock = acquireLock(cfg.stateDir);
  let transport;
  try {
    transport = await openTransport(cfg, { log, makeSocket: deps.makeSocket });
    const regex = buildTriggerRegex(cfg.triggers);
    const watchers = [];
    for (const account of cfg.accounts) {
      const w = new AccountWatcher({
        cfg, account, client: transport.client, regex, log, runJob,
        store: new AccountStore(cfg.stateDir, account.name),
      });
      await w.init();
      await w.reportInterrupted();
      watchers.push(w);
      log('info', { account: account.name, event: 'watching', transport: cfg.transport, instance: account.instance, ownerChat: w.ownerChat });
    }

    // Finish the poll in flight and every queued run before exiting. The LaunchAgent's
    // ExitTimeOut gives this the length of one run.
    const stopped = new Promise(resolve => {
      if (deps.signal) {
        if (deps.signal.aborted) resolve('abort');
        deps.signal.addEventListener('abort', () => resolve('abort'), { once: true });
        return;
      }
      let signalled = false;
      const stop = sig => {
        if (signalled) process.exit(1);
        signalled = true;
        resolve(sig);
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    });
    let stopping = false;
    stopped.then(sig => { stopping = true; log('info', { event: 'stopping', signal: sig }); });

    const failures = new Map();
    while (!stopping) {
      await Promise.all(watchers.map(async w => {
        try {
          await w.poll();
          if (failures.get(w.account.name)) log('info', { account: w.account.name, event: 'poll-recovered' });
          failures.set(w.account.name, 0);
        } catch (err) {
          const n = (failures.get(w.account.name) || 0) + 1;
          failures.set(w.account.name, n);
          // Log the first failure and then every 30th, so an outage does not flood the log.
          if (n === 1 || n % 30 === 0) log('error', { account: w.account.name, event: 'poll-failed', count: n, error: err.message });
        }
      }));
      await Promise.race([stopped, new Promise(r => setTimeout(r, cfg.pollMs))]);
    }
    await Promise.all(watchers.map(w => w.drain()));
  } finally {
    await transport?.close();
    releaseLock();
  }
}
