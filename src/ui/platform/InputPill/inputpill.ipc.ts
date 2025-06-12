// src/apps/InputPill/input-pill.ipc.ts
import { AppIpcModule, AppMainProcessInstances } from '@core/platform/ipc/types';
import { BaseAppWindow } from '@ui/common/base-app-window';
import * as logger from '@utils/logger';
import { IpcMain } from 'electron';

// Placeholder for a more robust event bus if we introduce one.
// For now, we might listen to events directly on ipcMain if main-handlers.ts emits them,
// or handle direct calls if main-handlers.ts is refactored to call app-specific functions.

const InputPillIpcHandlers: AppIpcModule = {
    moduleId: 'InputPill',

    registerMainProcessHandlers: (
        ipcMainInstance: IpcMain,
        appInstance: BaseAppWindow,
        allAppInstances?: AppMainProcessInstances
    ) => {
        logger.info(`[InputPill.ipc] Registering IPC handlers for ${InputPillIpcHandlers.moduleId}`);

        const handleAgentResponse = (response: string | object) => {
            if (appInstance && appInstance.window && !appInstance.window.isDestroyed()) {
                logger.debug(`[InputPill.ipc] Sending 'agent-response' to InputPill UI:`, response);
                appInstance.window.webContents.send('agent-response', response);
            } else {
                logger.warn('[InputPill.ipc] InputPill window not available to send agent-response.');
            }
        };

        const handleAgentProcessing = () => {
            if (appInstance && appInstance.window && !appInstance.window.isDestroyed()) {
                logger.debug(`[InputPill.ipc] Sending 'agent-processing' to InputPill UI.`);
                appInstance.window.webContents.send('agent-processing');
            } else {
                logger.warn('[InputPill.ipc] InputPill window not available to send agent-processing.');
            }
        };
        
        // These would be subscribed to if main-handlers.ts or an event bus emits them:
        // ipcMainInstance.on('global-agent-response', (event, response) => handleAgentResponse(response));
        // ipcMainInstance.on('global-agent-processing', () => handleAgentProcessing());


        // For the TRANSITIONAL PERIOD:
        // The 'run-agent' handler in main-handlers.ts still directly sends to InputPill.
        // So, for now, this module doesn't need to re-register listeners for 'agent-response'
        // or 'agent-processing' if they are still being sent directly by the old logic.
        // Once main-handlers.ts is refactored to *not* send directly to InputPill,
        // then InputPill's IPC module will need to subscribe to generic events.

        // If InputPill needed to INITIATE IPC *from* the main process to its renderer,
        // or handle specific messages *from* its renderer, those handlers would go here.
        // For example:
        // ipcMainInstance.on('input-pill-custom-action', (event, args) => {
        //     logger.info(`[InputPill.ipc] Received 'input-pill-custom-action'`, args);
        //     // Do something with appInstance or canvasEngine
        // });

        logger.info(`[InputPill.ipc] IPC handlers for ${InputPillIpcHandlers.moduleId} registered (or placeholder for now).`);
    }
};

export default InputPillIpcHandlers;
