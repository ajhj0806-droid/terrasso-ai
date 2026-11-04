// Fila em memória: uma conversa por vez, com espera curta para juntar
// mensagens picadas. Suficiente para um salão; para vários salões, trocar
// por fila no banco (pgmq) ou um worker separado.
const DEBOUNCE_MS = Number(process.env.AI_DEBOUNCE_MS ?? 2500);
const timers = new Map<string, NodeJS.Timeout>();
const chains = new Map<string, Promise<void>>();

export function schedule(key: string, job: () => Promise<void>) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(job).catch((e) => console.error("job", key, e));
    chains.set(key, next);
    next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  }, DEBOUNCE_MS));
}

export function pendingJobs(): number {
  return timers.size + chains.size;
}
