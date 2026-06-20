import { describe, it, expect } from 'vitest';
import {
  resolveContextPackConfig,
  buildContextPackRequest,
} from './contextPackHydration.js';

describe('opencode context-pack hydration', () => {
  it('requires both an api key and an initiative', () => {
    expect(resolveContextPackConfig({})).toBeNull();
    expect(resolveContextPackConfig({ ORGX_API_KEY: 'k' })).toBeNull();
    expect(
      resolveContextPackConfig({ ORGX_API_KEY: 'k', ORGX_INITIATIVE_ID: 'i1' })
    ).toEqual({ apiKey: 'k', baseUrl: 'https://useorgx.com', initiativeId: 'i1' });
  });
  it('builds the endpoint request with bearer auth', () => {
    const { url, init } = buildContextPackRequest({
      apiKey: 'k',
      baseUrl: 'https://useorgx.com/',
      initiativeId: 'i1',
    });
    expect(url).toBe('https://useorgx.com/api/client/context-pack');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toEqual({ initiative_id: 'i1' });
  });
});
