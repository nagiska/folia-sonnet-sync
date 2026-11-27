'use strict';

// The Apple Music page has its own storefront (the region in its URL), and the account has the
// storefront Apple reports for it. MusicKit takes its storefront from the page, and a page in
// another region than the account's plays only previews (or refuses songs that region lacks).
// This decides whether the page has to move, and where to.
function storefrontTarget(currentUrl, storefront) {
    if (typeof storefront !== 'string' || !/^[a-z]{2}$/.test(storefront)) return null;
    try {
        const url = new URL(currentUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com') return null;
        const current = url.pathname.split('/')[1];
        if (current === storefront) return null;
        return `https://music.apple.com/${storefront}/`;
    } catch {
        return null;
    }
}

// The region a music page is in, read from its address; null for anything else.
function pageStorefront(address) {
    try {
        const url = new URL(address);
        if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com') return null;
        const region = url.pathname.split('/')[1];
        return /^[a-z]{2}$/.test(region) ? region : null;
    } catch {
        return null;
    }
}

// Runs inside the Apple page, before a start or a prepared queue. From a mainland address Apple
// redirects every page outside /cn back to /cn, so the page cannot always move to the account's
// region. Point MusicKit at the account's storefront in place instead, and lift the preview-only
// mode the web app chose for the other region when the account has a subscription.
async function alignStorefront(mk, call) {
    if (mk?.isAuthorized !== true) return;
    const isRegion = id => typeof id === 'string' && /^[a-z]{2}$/.test(id);
    // The region Folia's catalog reads used (companionRequests.cjs), else the one MusicKit has.
    const read = window.__foliaStorefront?.data?.data?.[0]?.id;
    let account = typeof read === 'string' ? read : mk.storefrontCountryCode;
    if (window.__foliaCompanionHost === 'android' && !isRegion(read)) {
        // The native host remembers the account region across Apple page redirects. A first start
        // may precede even its account probe, in which case ask the signed-in page directly.
        const nativeRegion = window.__foliaAccountStorefront;
        if (isRegion(nativeRegion)) account = nativeRegion;
        else if (typeof call === 'function') {
            try {
                const answer = await call('v1/me/storefront');
                const id = answer?.data?.data?.[0]?.id;
                if (mk.isAuthorized === true && isRegion(id)) {
                    account = id;
                    window.__foliaAccountStorefront = id;
                    window.__foliaStorefront = answer;
                    window.FoliaAppleMusicBridge?.storefront?.(id);
                }
            } catch { /* Keep MusicKit's own region if the account region is unavailable. */ }
        }
    }
    if (mk.isAuthorized !== true || !isRegion(account)) return;
    if (mk.storefrontId !== account) {
        mk.storefrontId = account;
        window.__foliaStorefrontAligned = true;
    }
    // A page already in the account's region keeps the playback mode the web app chose for it.
    if (window.__foliaStorefrontAligned !== true) return;
    const modes = window.MusicKit?.PlaybackMode;
    if (!modes || mk.playbackMode !== modes.PREVIEW_ONLY || typeof mk.hasMusicSubscription !== 'function') return;
    // One question at a time per page, and a late answer still counts for the next start. A start
    // waits for it three seconds at most, then plays the previews, as before.
    if (typeof window.__foliaSubscribed !== 'boolean') {
        if (!window.__foliaSubscription) {
            const subscription = Promise.resolve().then(() => mk.hasMusicSubscription()).then(answer => {
                if (window.__foliaSubscription === subscription && typeof answer === 'boolean') window.__foliaSubscribed = answer;
            }, () => {}).finally(() => {
                if (window.__foliaSubscription === subscription) window.__foliaSubscription = null;
            });
            window.__foliaSubscription = subscription;
        }
        let timer;
        await Promise.race([window.__foliaSubscription, new Promise(done => { timer = setTimeout(done, 3000); })]);
        clearTimeout(timer);
    }
    if (window.__foliaSubscribed === true) mk.playbackMode = modes.MIXED_CONTENT;
}

module.exports = { storefrontTarget, pageStorefront, alignStorefront };
