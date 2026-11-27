/*
 * Facebook and Instagram open ad links in their own in-app browser, where Google sign-in is blocked
 * (Google refuses OAuth in embedded web views). Their user agents carry FBAN / FBAV / FB_IAB / FBIOS
 * (Facebook, Messenger) or "Instagram".
 */
// TikTok's in-app browser (musical_ly / BytedanceWebview / trill) blocks Google sign-in the same way.
const IN_APP = /\b(FBAN|FBAV|FB_IAB|FBIOS|FBSS|FBDV|FB4A)\b|Instagram|musical_ly|BytedanceWebview|\btrill_/i;

export function isMetaInAppBrowser(userAgent) {
  return typeof userAgent === 'string' && IN_APP.test(userAgent);
}

export const IN_APP_NOTICE =
  "Google sign-in doesn't work inside the Facebook, Instagram or TikTok app. Use email, or open this page in your browser (tap ••• then Open in browser).";
