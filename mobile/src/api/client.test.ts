// The refresh flow is the one piece of real async/state logic in this
// module (everything else is a thin fetch wrapper) - see the comment above
// `refreshPromise` in client.ts for why dedup matters: refresh tokens
// rotate on use, so if every concurrent 401 independently POSTed to
// /auth/mobile/refresh, only the first would succeed and the rest would
// read their own 401 as "session is dead" and log the user out from under
// a perfectly valid session.
//
// Each test gets a fresh module (jest.resetModules) because client.ts
// keeps currentTokens/refreshPromise/onTokensRefreshed as module-level
// state with no reset hook of its own - reusing one import across tests
// would leak state between them.

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('api client - token refresh', () => {
  let fetchMock: jest.Mock;
  let client: typeof import('./client');

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;
    client = require('./client');
  });

  test('an authenticated request attaches the access token as a Bearer header', async () => {
    client.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await client.api.get('/listings');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer access-1');
  });

  test('concurrent 401s share a single in-flight refresh call, and both callers succeed', async () => {
    client.setTokens({ accessToken: 'stale-access', refreshToken: 'refresh-1' });

    const callCounts: Record<string, number> = {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/mobile/refresh')) {
        callCounts.refresh = (callCounts.refresh || 0) + 1;
        return jsonResponse(200, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
      }
      const path = url.includes('/foo') ? 'foo' : 'bar';
      callCounts[path] = (callCounts[path] || 0) + 1;
      // First hit on each path is a stale-token 401; the retry after
      // refresh succeeds.
      return callCounts[path] === 1 ? jsonResponse(401, { error: 'expired' }) : jsonResponse(200, { path });
    });

    const [foo, bar] = await Promise.all([client.api.get('/foo'), client.api.get('/bar')]);

    expect(foo).toEqual({ path: 'foo' });
    expect(bar).toEqual({ path: 'bar' });
    expect(callCounts.refresh).toBe(1);
    expect(client.getTokens()).toEqual({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
  });

  test('a successful refresh notifies the registered listener with the rotated tokens', async () => {
    client.setTokens({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    const onRefreshed = jest.fn();
    client.registerTokenListener(onRefreshed);

    let requestCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/mobile/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
      }
      requestCount += 1;
      return requestCount === 1 ? jsonResponse(401, { error: 'expired' }) : jsonResponse(200, { ok: true });
    });

    await client.api.get('/listings');

    expect(onRefreshed).toHaveBeenCalledWith({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
  });

  test('a failed refresh clears tokens, notifies the listener with null, and the original 401 propagates', async () => {
    client.setTokens({ accessToken: 'stale-access', refreshToken: 'dead-refresh' });
    const onRefreshed = jest.fn();
    client.registerTokenListener(onRefreshed);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/mobile/refresh')) {
        return jsonResponse(401, { error: 'invalid_refresh_token' });
      }
      return jsonResponse(401, { error: 'expired' });
    });

    await expect(client.api.get('/listings')).rejects.toMatchObject({ status: 401 });

    expect(onRefreshed).toHaveBeenCalledWith(null);
    expect(client.getTokens()).toBeNull();
  });

  test('without any tokens set, a 401 is not retried (there is nothing to refresh)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'no_session' }));

    await expect(client.api.get('/listings')).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
