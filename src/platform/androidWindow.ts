import { registerPlugin } from '@capacitor/core';

// 当前文件：Android 窗口桥接；系统栏与安全区由原生统一管理。
interface AndroidWindowPlugin {
  configure(options: { immersive: boolean; isDaylight: boolean }): Promise<void>;
}

export const androidWindow = registerPlugin<AndroidWindowPlugin>('FoliaWindow');
