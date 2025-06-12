import { AppIpcModule, AppMainProcessInstances } from '@core/platform/ipc/types';
import { BaseAppWindow } from '@ui/common/base-app-window';
import { createLogger } from '@utils/logger';
import { IpcMain } from 'electron';

const logger = createLogger('[NotesIPC]');

const NotesIpcHandlers: AppIpcModule = {
    moduleId: 'Notes',
    
    registerMainProcessHandlers: (
        ipcMain: IpcMain,
        appInstance: BaseAppWindow,
        allAppInstances?: AppMainProcessInstances
    ) => {
        logger.info('Registering notes IPC handlers');

        // Example: Handle app-specific events
        ipcMain.handle('notes:example-action', async (event, data) => {
            try {
                logger.info(`Example action called with:`, data);
                // Add your app-specific logic here
                return { success: true, result: 'Example result' };
            } catch (error) {
                logger.error('Error in example action:', error);
                return { success: false, error: 'Failed to execute action' };
            }
        });

        // Focus the app window
        ipcMain.on('notes:focus', () => {
            if (appInstance && appInstance.window && !appInstance.window.isDestroyed()) {
                appInstance.focus();
            }
        });

        logger.info('notes IPC handlers registered successfully');
    }
};

export default NotesIpcHandlers;