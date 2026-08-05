import { describe, expect, it } from 'vitest';

import {
  captureGatewayCredential,
  sanitizedChildProcessEnv,
} from './childProcessEnv.js';

describe('gateway credential isolation', () => {
  it('captures the preferred credential and removes both aliases', () => {
    const env = {
      ORGX_API_KEY: ' oxk_primary ',
      ORGX_GATEWAY_KEY: 'oxk_fallback',
      PATH: '/bin',
    };

    expect(captureGatewayCredential(env)).toBe('oxk_primary');
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('never passes gateway credentials to a child environment', () => {
    expect(
      sanitizedChildProcessEnv(
        { ORGX_API_KEY: 'oxk_parent', PATH: '/bin' },
        { ORGX_GATEWAY_KEY: 'oxk_override', HOME: '/tmp/home' }
      )
    ).toEqual({ PATH: '/bin', HOME: '/tmp/home' });
  });
});
