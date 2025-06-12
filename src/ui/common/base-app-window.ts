import { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { createAppFileLoader } from '@lib/utils/app-file-loader';

export class BaseAppWindow {
    public window: BrowserWindow;
    protected fileLoader: ReturnType<typeof createAppFileLoader>;

    constructor(
        bounds: { width: number; height: number; x?: number; y?: number },
        title: string,
        viteDevServerUrl: string | undefined,
        preloadPath: string,
        options: BrowserWindowConstructorOptions = {}
    ) {
        this.fileLoader = createAppFileLoader(viteDevServerUrl);
        this.window = new BrowserWindow({
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            title,
            webPreferences: {
                preload: preloadPath,
                nodeIntegration: false,
                contextIsolation: true,
            },
            show: false,
            ...options
        });
    }

    async load(componentPath: string, loggerPrefix: string): Promise<void> {
        await this.fileLoader.loadAppHtml(this.window, componentPath, loggerPrefix);
    }

    focus(): void {
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isMinimized()) {
                this.window.restore();
            }
            if (!this.window.isVisible()) {
                this.window.show();
            }
            this.window.focus();
            this.window.webContents.focus();
        }
    }

    close(): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.close();
        }
    }
}
