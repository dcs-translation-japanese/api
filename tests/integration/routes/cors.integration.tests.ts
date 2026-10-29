import { describe, expect, it } from 'vitest';
import app from '@/index';
import { createTestBindings } from '../../helpers/environment';

describe('Pages origin CORS', () => {
  const env = createTestBindings({
    AllowOrigins: 'https://5kdn.github.io,https://dcs-translation-japanese.github.io',
  });

  it.each(['https://5kdn.github.io', 'https://dcs-translation-japanese.github.io'])(
    'allows %s for reads and preflight',
    async (origin) => {
      const response = await app.fetch(
        new Request('http://localhost/health', { headers: { Origin: origin } }),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);

      const preflight = await app.fetch(
        new Request('http://localhost/create-pr', {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Content-Type,Authorization',
          },
        }),
        env,
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    },
  );

  it.each([
    'https://dcs-translation-japanese.github.io.evil.example',
    'https://dcs-translation-japanese.github.io/WebUI/',
    'https://untrusted.example',
  ])('does not allow %s', async (origin) => {
    const response = await app.fetch(
      new Request('http://localhost/health', { headers: { Origin: origin } }),
      env,
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
