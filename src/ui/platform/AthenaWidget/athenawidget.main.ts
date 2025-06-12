// src/ui/athena-widget.ts
import { getWindowRegistry } from '@/core/platform/windows/window-registry';
import * as logger from '@utils/logger';
import { BrowserWindow, Display } from 'electron';
import { BaseAppWindow } from '@ui/common/base-app-window';


export class AthenaWidgetWindow extends BaseAppWindow {
    public window: BrowserWindow;

    constructor(primaryDisplay: Display, viteDevServerUrl: string | undefined, preloadPath: string) {
        const x = primaryDisplay.workArea.x + primaryDisplay.workAreaSize.width - 350 - 20;
        const y = primaryDisplay.workArea.y + 20;

        super(
            { width: 350, height: 500, x, y },
            'Athena Conversation Monitor',
            viteDevServerUrl,
            preloadPath,
            {
                frame: false,
                transparent: true,
                vibrancy: 'sidebar',
                alwaysOnTop: false,
            }
        );
    }

    async init(): Promise<void> {
        try {
            await this.fileLoader.loadAppHtml(
                this.window,
                'platform/AthenaWidget',
                '[AthenaWidgetWindow]'
            );
            logger.info('[AthenaWidgetWindow] Successfully loaded HTML file');
            
            // Register with Window Registry for better modularity
            const windowRegistry = getWindowRegistry();
            windowRegistry.registerWindow({
                id: 'athena-widget',
                title: 'Athena Conversation Monitor',
                type: 'platform',
                componentName: 'AthenaWidget',
                window: this.window,
                instance: this,
                capabilities: ['conversation-monitor', 'chat-display', 'agent-status']
            });
            
            logger.info('[AthenaWidgetWindow] Registered with Window Registry');

            // Show window when ready
            this.window.once('ready-to-show', () => {
                this.show();
                logger.info('[AthenaWidgetWindow] Window is ready and shown');
            });

        } catch (error) {
            logger.error('[AthenaWidgetWindow] Failed to load HTML file:', error);
            throw error;
        }
    }

    show(): void {
        if (this.window && !this.window.isDestroyed()) {
            super.focus();
        }
    }

    sendConversationUpdate(type: string, content: string): void {
        if (this.window && this.window.webContents && !this.window.isDestroyed()) {
            this.window.webContents.send('conversation-update', { type, content });
        }
    }
}
