import { useEffect } from 'react';
import { androidWindow } from '../platform/androidWindow';
import { isCapacitorAndroid } from '../platform/runtime';
import { useAppViewStore } from '../stores/useAppViewStore';

// 当前文件：同步 Android 播放页沉浸状态和系统栏图标主题。
export const useCapacitorSystemBars = (isDaylight: boolean): void => {
  useEffect(() => {
    if (!isCapacitorAndroid()) return;

    document.documentElement.dataset.runtime = 'capacitor-android';
    const syncWindow = () => {
      void androidWindow.configure({
        immersive: useAppViewStore.getState().view === 'player',
        isDaylight,
      }).catch(error => console.warn('[AndroidWindow] Could not configure system bars', error));
    };
    syncWindow();
    const unsubscribe = useAppViewStore.subscribe((state, previous) => {
      if (state.view !== previous.view) syncWindow();
    });

    return unsubscribe;
  }, [isDaylight]);
};
