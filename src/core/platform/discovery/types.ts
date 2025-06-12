import { BrowserWindow, Display } from 'electron';
import { AppIpcModule } from '../ipc/types';

export interface AppModuleInstance {
    window?: BrowserWindow;
    init?: () => void;
}

export type AppModuleConstructor = new (
    primaryDisplay: Display,
    viteDevServerUrl: string | undefined,
    preloadPath: string
) => AppModuleInstance;

export interface AppModule {
    name: string;
    type: 'platform' | 'app' | 'widget';
    mainClass?: AppModuleConstructor;
    ipcHandlers?: AppIpcModule;
    instance?: AppModuleInstance;
    fullPath: string;
    actualPath: string;
}

export interface UIDiscoveryConfig {
    uiDir: string;
    primaryDisplay: Display;
    viteDevServerUrl?: string;
    preloadBasePath: string;
}

export interface UIComponentRegistry {
    mainClasses: Map<string, AppModuleConstructor>;
    ipcModules: Map<string, AppIpcModule>;
}

export interface DiscoveredComponent {
    name: string;
    type: 'platform' | 'app' | 'widget';
    path: string;
    hasMain: boolean;
    hasIpc: boolean;
    hasPreload: boolean;
}
