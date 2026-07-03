// Wrapper fetch API: JSON, errori tipizzati, cookie di sessione same-origin.
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* risposta non JSON */ }
  if (!res.ok) {
    throw new ApiError(res.status, json?.error || `HTTP ${res.status}`, json);
  }
  return json;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  del: (url) => request('DELETE', url),
};
