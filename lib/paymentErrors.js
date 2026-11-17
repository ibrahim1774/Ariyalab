/*
 * What a buyer sees when the payment page cannot be started. A 5xx, a network failure or an
 * unreadable answer always shows the plain line below: never text that came from the payment
 * provider or the server's internals. A clear 4xx reason from our own server (sign in, no billing
 * account yet, prices changed) is kept, because it tells the buyer what to do.
 */
export const CHECKOUT_FAILED = "We couldn't start the payment. Please try again in a moment.";
export const PORTAL_FAILED = "We couldn't open billing. Please try again in a moment.";

export class PaymentError extends Error {}

/** Throw a PaymentError for a response that did not give a payment url. */
export function failPayment(res, data, fallback) {
  const clear = res && res.status >= 400 && res.status < 500 && typeof data?.error === 'string' && data.error;
  throw new PaymentError(clear || fallback);
}

/** The line to show for whatever was thrown. */
export function paymentErrorText(err, fallback) {
  return err instanceof PaymentError ? err.message : fallback;
}
