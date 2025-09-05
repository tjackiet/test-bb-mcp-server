// lib/result.js
export const ok = (summary, data = {}, meta = {}) => ({
  ok: true,
  summary,
  data,
  meta,
});

export const fail = (message, type = 'user', meta = {}) => ({
  ok: false,
  summary: `Error: ${message}`,
  data: {},
  meta: { errorType: type, ...meta },
});
