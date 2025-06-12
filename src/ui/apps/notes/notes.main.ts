import { BrowserWindow, Display } from 'electron';
import * as logger from '@utils/logger';
import { BaseAppWindow } from '@ui/common/base-app-window';

export class NotesWindow extends BaseAppWindow {
    public window: BrowserWindow;

    constructor(primaryDisplay: Display, viteDevServerUrl: string | undefined, preloadPath: string) {
        super(
            { width: 800, height: 600 },
            'notes',
            viteDevServerUrl,
            preloadPath,
            {
                frame: false,
                backgroundColor: '#ffffff',
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
                'apps/notes',
                '[NotesWindow]'
            );
            logger.info('[NotesWindow] Successfully loaded HTML file');
        } catch (error) {
            logger.error('[NotesWindow] Failed to load HTML file:', error);
            throw error;
        }
        
        // Open DevTools in development
        if (this.fileLoader.isDevelopment()) {
            // this.window.webContents.openDevTools({ mode: 'detach' });
        }
    }
}