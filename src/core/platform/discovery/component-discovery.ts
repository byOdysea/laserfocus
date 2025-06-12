import { createLogger } from '@/lib/utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredComponent, AppModuleConstructor, AppIpcModule } from './types';
import { isValidIpcModule } from './component-registry';

const logger = createLogger('[ComponentDiscovery]');

export async function scanComponents(basePath: string): Promise<DiscoveredComponent[]> {
    const components: DiscoveredComponent[] = [];

    async function analyze(relativePath: string, type: 'platform' | 'app' | 'widget'): Promise<DiscoveredComponent | null> {
        const fullPath = path.join(basePath, relativePath);
        const componentName = path.basename(relativePath);
        try {
            const files = fs.readdirSync(fullPath);
            const hasMain = files.some(f => f.endsWith('.main.ts') || f.endsWith('.main.js') || f === 'main.ts' || f === 'main.js');
            const hasIpc = files.some(f => f.endsWith('.ipc.ts') || f.endsWith('.ipc.js') || f === 'ipc.ts' || f === 'ipc.js');
            const hasPreload = files.some(f => f === 'preload.ts' || f === 'preload.js');
            if (hasMain || hasIpc) {
                return { name: componentName, type, path: relativePath, hasMain, hasIpc, hasPreload };
            }
        } catch (error) {
            logger.debug(`Could not analyze component ${componentName}:`, error);
        }
        return null;
    }

    try {
        const platformPath = path.join(basePath, 'platform');
        if (fs.existsSync(platformPath)) {
            const dirs = fs.readdirSync(platformPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            for (const dir of dirs) {
                const c = await analyze(path.join('platform', dir), 'platform');
                if (c) components.push(c);
            }
        }
        const appsPath = path.join(basePath, 'apps');
        if (fs.existsSync(appsPath)) {
            const dirs = fs.readdirSync(appsPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            for (const dir of dirs) {
                const c = await analyze(path.join('apps', dir), 'app');
                if (c) components.push(c);
            }
        }
        const widgetsPath = path.join(basePath, 'widgets');
        if (fs.existsSync(widgetsPath)) {
            const dirs = fs.readdirSync(widgetsPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            for (const dir of dirs) {
                const c = await analyze(path.join('widgets', dir), 'widget');
                if (c) components.push(c);
            }
        }
    } catch (error) {
        logger.warn('Error scanning UI directory:', error);
    }

    return components;
}

export async function loadComponentModules(component: DiscoveredComponent, uiBasePath: string): Promise<{ mainClass?: AppModuleConstructor; ipcHandlers?: AppIpcModule }> {
    const result: { mainClass?: AppModuleConstructor; ipcHandlers?: AppIpcModule } = {};

    if (component.hasMain) {
        try {
            const mainModulePath = path.join(uiBasePath, component.path, getMainFileName(component.name));
            const mainModule = await import(mainModulePath);
            for (const [key, value] of Object.entries(mainModule)) {
                if (typeof value === 'function' && (key.includes('Window') || key.includes(component.name))) {
                    result.mainClass = value as AppModuleConstructor;
                    break;
                }
            }
        } catch (error) {
            logger.debug(`Could not load main class for ${component.name}:`, error);
        }
    }

    if (component.hasIpc) {
        try {
            const ipcModulePath = path.join(uiBasePath, component.path, getIpcFileName(component.name));
            const ipcModule = await import(ipcModulePath);
            if (ipcModule.default && isValidIpcModule(ipcModule.default)) {
                result.ipcHandlers = ipcModule.default;
            }
        } catch (error) {
            logger.debug(`Could not load IPC handlers for ${component.name}:`, error);
        }
    }

    return result;
}

export function getMainFileName(componentName: string): string {
    return `${componentName.toLowerCase()}.main.ts`;
}

export function getIpcFileName(componentName: string): string {
    return `${componentName.toLowerCase()}.ipc.ts`;
}
