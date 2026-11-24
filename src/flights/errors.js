export class OfferExpiredError extends Error {
  constructor(msg = 'This fare is no longer available') {
    super(msg);
    this.name = 'OfferExpiredError';
  }
}

export class ProviderError extends Error {
  constructor(msg, details) {
    super(msg);
    this.name = 'ProviderError';
    this.details = details;
  }
}
