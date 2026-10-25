// ── Simple structured logger ──

const timestamp = () => new Date().toISOString();

export const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'info',  ts: timestamp(), msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'warn',  ts: timestamp(), msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'error', ts: timestamp(), msg, ...ctx })),
};
