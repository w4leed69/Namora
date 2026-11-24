import { createMockProvider } from './mock.js';
import { createDuffelProvider } from './duffel.js';

export function createFlightProvider(cfg) {
  switch (cfg.provider) {
    case 'duffel':
      return createDuffelProvider({ token: cfg.duffelToken, cabinClass: cfg.cabinClass, maxResults: cfg.maxResults });
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown FLIGHT_PROVIDER "${cfg.provider}" (use mock or duffel)`);
  }
}

export { OfferExpiredError, ProviderError } from './errors.js';
