import { createLogger } from '@/lib/utils/logger';
import { AppIpcModule } from '../ipc/types';
import { AppModuleConstructor, UIComponentRegistry } from './types';

const logger = createLogger('[ComponentRegistry]');

export async function loadUIRegistry(): Promise<UIComponentRegistry | null> {
    try {
        const registryModule = await import('./app-registry');
        return registryModule.createAppRegistry();
    } catch (error) {
        logger.warn('Could not load UI component registry:', error);
        return null;
    }
}

export function classifyAppType(appName: string): 'platform' | 'app' | 'widget' {
    try {
        const registryModule = require('./app-registry');
        return registryModule.getAppType(appName);
    } catch {
        const platformUIComponents = ['AthenaWidget', 'Byokwidget', 'InputPill'];
        return platformUIComponents.includes(appName) ? 'platform' : 'app';
    }
}

export function getAppPath(appName: string): string {
    try {
        const registryModule = require('./app-registry');
        return registryModule.getAppPath(appName);
    } catch {
        const knownAppPaths: Record<string, string> = {
            'AthenaWidget': 'platform/AthenaWidget',
            'Byokwidget': 'platform/Byokwidget',
            'InputPill': 'platform/InputPill',
            'Notes': 'apps/notes',
            'Reminders': 'apps/reminders',
            'Settings': 'apps/settings'
        };
        if (knownAppPaths[appName]) return knownAppPaths[appName];
        const basePath = classifyAppType(appName) === 'platform' ? 'platform' : 'apps';
        return `${basePath}/${appName}`;
    }
}

export function isValidIpcModule(obj: any): obj is AppIpcModule {
    return obj &&
        typeof obj === 'object' &&
        typeof obj.moduleId === 'string' &&
        typeof obj.registerMainProcessHandlers === 'function';
}
