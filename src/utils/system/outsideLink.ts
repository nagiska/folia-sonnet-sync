import { Browser } from '@capacitor/browser';
import { isCapacitorAndroid } from '../../platform/runtime';

// src/utils/system/outsideLink.ts
// Opening a page outside the app, the one place that knows how: the desktop app hands the address
// to the system browser (a plain link would load it inside the app's own window), the web build
// opens a new tab.

/** Whether an outside address must go through a native host instead of a browser link. */
export const opensThroughDesktopApp = (): boolean => Boolean(window.electron?.openExternalUrl) || isCapacitorAndroid();

/**
 * Opens `url` outside the app. For a button or a row; text that is a link uses the settings kit's Link.
 * The promise ends when the desktop app has taken the address (at once in the web build) and
 * rejects when the desktop app could not take it: a place that tells of that waits for it or catches it.
 */
export const openOutsideLink = async (url: string): Promise<void> => {
    if (window.electron?.openExternalUrl) {
        await window.electron.openExternalUrl(url);
        return;
    }
    if (isCapacitorAndroid()) {
        await Browser.open({ url });
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
};
