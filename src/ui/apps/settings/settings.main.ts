import { getWindowRegistry } from '@core/platform/windows/window-registry';
import * as logger from '@utils/logger';
import { BrowserWindow, Display } from 'electron';
import { BaseAppWindow } from '@ui/common/base-app-window';

export class SettingsWindow extends BaseAppWindow {
    public window: BrowserWindow;

    constructor(primaryDisplay: Display, viteDevServerUrl: string | undefined, preloadPath: string) {
        super(
            { width: 800, height: 600 },
            'settings',
            viteDevServerUrl,
            preloadPath,
            {
                frame: false,
                transparent: true,
                vibrancy: 'sidebar',
                minWidth: 400,
                minHeight: 300,
            }
        );

        this.window.once('ready-to-show', () => {
            this.window.show();
        });
    }

    async init(): Promise<void> {
        try {
            await this.fileLoader.loadAppHtml(
                this.window, 
                'apps/settings', 
                '[SettingsWindow]'
            );
            logger.info('[SettingsWindow] Successfully loaded HTML file');
            
            // Register with Window Registry
            const windowRegistry = getWindowRegistry();
            windowRegistry.registerWindow({
                id: 'settings',
                title: 'Settings',
                type: 'app',
                componentName: 'Settings',
                window: this.window,
                instance: this,
                capabilities: ['configuration', 'system-settings', 'mcp-management']
            });
            logger.info('[SettingsWindow] Registered with Window Registry');

            // Show window when ready
            this.window.once('ready-to-show', () => {
                this.window.show();
            });

        } catch (error) {
            logger.error('[SettingsWindow] Failed to load HTML file:', error);
            throw error;
        }
        
        // Open DevTools in development
        if (this.fileLoader.isDevelopment()) {
            // this.window.webContents.openDevTools({ mode: 'detach' });
        }
    }
}