import { createLogger } from '@/lib/utils/logger';
import { AppIpcModule, AppMainProcessInstances } from '@core/platform/ipc/types';
import { ipcMain } from 'electron';
import * as path from 'path';
import {
    UIDiscoveryConfig,
    AppModule,
    AppModuleInstance,
    UIComponentRegistry,
} from './types';
import {
    loadUIRegistry,
    classifyAppType,
    getAppPath,
    isValidIpcModule,
} from './component-registry';
import { scanComponents, loadComponentModules } from './component-discovery';

const logger = createLogger('[UIDiscovery]');

export class UIDiscoveryService {
    private platformComponents: Map<string, AppModule> = new Map();
    private applications: Map<string, AppModule> = new Map();
    private widgets: Map<string, AppModule> = new Map();
    private registry: UIComponentRegistry | null = null;

    constructor(private config: UIDiscoveryConfig) {}

    async discoverAndInitializeUIComponents(): Promise<{
        appInstances: AppMainProcessInstances;
        appModules: AppIpcModule[];
    }> {
        await this.discoverUIComponents();
        await this.initializePlatformComponents();
        return this.getRegistrationData();
    }

    async initializeUIWindow(windowName: string): Promise<AppModule | null> {
        const app = this.applications.get(windowName) || this.widgets.get(windowName);
        if (!app) {
            logger.warn(`UI Window ${windowName} not found`);
            return null;
        }
        if (app.instance) {
            if (app.instance.window && app.instance.window.isDestroyed()) {
                app.instance = undefined;
            } else {
                return app;
            }
        }
        if (!app.mainClass) {
            logger.warn(`UI Window ${windowName} has no main class`);
            return null;
        }
        try {
            const { primaryDisplay, viteDevServerUrl, preloadBasePath } = this.config;
            const preloadPath = path.join(preloadBasePath, `../ui/${app.actualPath}/preload.js`);
            const instance = new app.mainClass(primaryDisplay, viteDevServerUrl, preloadPath);
            instance.init?.();
            app.instance = instance;
            if (app.ipcHandlers && isValidIpcModule(app.ipcHandlers)) {
                const { appInstances } = this.getRegistrationData();
                const moduleId = app.ipcHandlers.moduleId || windowName;
                appInstances.set(moduleId, instance);
                app.ipcHandlers.registerMainProcessHandlers(ipcMain, instance, appInstances);
                if (instance.window && app.ipcHandlers.unregisterMainProcessHandlers) {
                    instance.window.on('closed', () => {
                        app.ipcHandlers!.unregisterMainProcessHandlers!(ipcMain, instance);
                    });
                }
            }
            return app;
        } catch (error) {
            logger.error(`Failed to initialize ${app.type} ${windowName}:`, error);
            return null;
        }
    }

    private async discoverUIComponents(): Promise<void> {
        this.registry = await loadUIRegistry();
        if (this.registry) {
            logger.info('Using auto-generated UI component registry...');
            await this.discoverFromRegistry();
        } else {
            this.registry = { mainClasses: new Map(), ipcModules: new Map() };
            await this.discoverUIComponentsDynamically();
        }
        logger.info(`Discovered ${this.platformComponents.size} platform UI components:`, Array.from(this.platformComponents.keys()));
        logger.info(`Discovered ${this.applications.size} applications:`, Array.from(this.applications.keys()));
        logger.info(`Discovered ${this.widgets.size} widgets:`, Array.from(this.widgets.keys()));
    }

    private async discoverFromRegistry(): Promise<void> {
        if (!this.registry) return;
        for (const [appName, mainClass] of this.registry.mainClasses) {
            const app: AppModule = {
                name: appName,
                type: classifyAppType(appName),
                fullPath: getAppPath(appName),
                actualPath: getAppPath(appName),
                mainClass,
            };
            const ipcHandlers = this.registry.ipcModules.get(appName);
            if (ipcHandlers && isValidIpcModule(ipcHandlers)) {
                app.ipcHandlers = ipcHandlers;
            }
            this.storeComponent(appName, app);
        }
        for (const [appName, ipcHandlers] of this.registry.ipcModules) {
            if (!this.platformComponents.has(appName) && !this.applications.has(appName) && !this.widgets.has(appName) && isValidIpcModule(ipcHandlers)) {
                const app: AppModule = {
                    name: appName,
                    type: classifyAppType(appName),
                    ipcHandlers,
                    fullPath: getAppPath(appName),
                    actualPath: getAppPath(appName),
                };
                this.storeComponent(appName, app);
            }
        }
    }

    private async discoverUIComponentsDynamically(): Promise<void> {
        const uiBasePath = path.join(process.cwd(), this.config.uiDir);
        const discoveredComponents = await scanComponents(uiBasePath);
        for (const component of discoveredComponents) {
            const modules = await loadComponentModules(component, uiBasePath);
            const app: AppModule = {
                name: component.name,
                type: component.type,
                fullPath: component.path,
                actualPath: component.path,
                ...modules,
            };
            this.storeComponent(app.name, app);
        }
    }

    private storeComponent(name: string, app: AppModule): void {
        if (app.type === 'platform') {
            this.platformComponents.set(name, app);
        } else if (app.type === 'widget') {
            this.widgets.set(name, app);
        } else {
            this.applications.set(name, app);
        }
    }

    private async initializePlatformComponents(): Promise<void> {
        const { primaryDisplay, viteDevServerUrl, preloadBasePath } = this.config;
        for (const [appName, app] of this.platformComponents) {
            if (app.mainClass) {
                try {
                    const preloadPath = path.join(preloadBasePath, `../ui/${app.actualPath}/preload.js`);
                    const instance = new app.mainClass(primaryDisplay, viteDevServerUrl, preloadPath);
                    instance.init?.();
                    app.instance = instance;
                } catch (error) {
                    logger.error(`Failed to initialize platform UI component ${appName}:`, error);
                }
            }
        }
    }

    private getRegistrationData(): {
        appInstances: AppMainProcessInstances;
        appModules: AppIpcModule[];
    } {
        const appInstances: AppMainProcessInstances = new Map();
        const appModules: AppIpcModule[] = [];
        const collect = (map: Map<string, AppModule>) => {
            map.forEach((app, name) => {
                if (app.instance) appInstances.set(name, app.instance);
                if (app.ipcHandlers) appModules.push(app.ipcHandlers);
            });
        };
        collect(this.platformComponents);
        collect(this.applications);
        collect(this.widgets);
        return { appInstances, appModules };
    }

    getAppInstance(appName: string): AppModuleInstance | undefined {
        const app = this.applications.get(appName) || this.widgets.get(appName) || this.platformComponents.get(appName);
        return app?.instance;
    }

    getAllApps(): string[] {
        return [
            ...this.applications.keys(),
            ...this.widgets.keys(),
            ...this.platformComponents.keys(),
        ];
    }

    getPlatformComponents(): string[] {
        return Array.from(this.platformComponents.keys());
    }

    getAvailableApplications(): string[] {
        return Array.from(this.applications.keys());
    }

    async reloadRegistry(): Promise<void> {
        try {
            delete require.cache[require.resolve('./app-registry')];
            const runningPlatformComponents = new Map(this.platformComponents);
            this.applications.clear();
            this.widgets.clear();
            await this.discoverUIComponents();
            for (const [name, component] of runningPlatformComponents) {
                if (component.instance && !component.instance.window?.isDestroyed()) {
                    this.platformComponents.set(name, component);
                }
            }
        } catch (error) {
            logger.error('Failed to reload registry:', error);
            throw error;
        }
    }
}

let uiDiscoveryService: UIDiscoveryService | null = null;

export function setUIDiscoveryService(service: UIDiscoveryService): void {
    uiDiscoveryService = service;
}

export function getUIDiscoveryService(): UIDiscoveryService | null {
    return uiDiscoveryService;
}

export function destroyUIDiscoveryService(): void {
    if (uiDiscoveryService) {
        uiDiscoveryService = null;
        logger.info('Destroyed UI discovery service');
    }
}
