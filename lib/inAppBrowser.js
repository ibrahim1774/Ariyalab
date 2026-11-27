/*
 * Facebook and Instagram open ad links in their own in-app browser, where Google sign-in is blocked
 * (Google refuses OAuth in embedded web views). Their user agents carry FBAN / FBAV / FB_IAB / FBIOS
 * (Facebook, Messenger) or "Instagram".
 */
const IN_APP = /\b(FBAN|FBAV|FB_IAB|FBIOS|FBSS|FBDV|FB4A)\b|Instagram/i;

export function isMetaInAppBrowser(userAgent) {
  return typeof userAgent === 'string' && IN_APP.test(userAgent);
}

export const IN_APP_NOTICE =
  "Google sign-in doesn't work inside the Facebook app. Use email, or open this page in your browser (tap ••• then Open in browser).";
