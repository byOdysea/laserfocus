import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('settingsAPI', {
    getConfig: () => ipcRenderer.invoke('settings:get-config'),
    updateConfig: (updates: any) => ipcRenderer.invoke('settings:update-config', updates),
    getSchema: () => ipcRenderer.invoke('settings:get-schema'),
    getModels: (provider: string) => ipcRenderer.invoke('settings:get-models', provider),
    openByokWidget: () => ipcRenderer.send('settings:open-byok-widget'),
    focus: () => ipcRenderer.send('settings:focus'),
    focusByokWidget: () => ipcRenderer.send('settings:open-byok-widget'),
    // MCP-related methods
    testMCPConnection: (serverConfig: any) => ipcRenderer.invoke('settings:test-mcp-connection', serverConfig),
    getMCPStatus: () => ipcRenderer.invoke('settings:get-mcp-status'),
    reloadMCP: () => ipcRenderer.invoke('settings:reload-mcp'),
    updateMCPServer: (serverId: string, config: any) => ipcRenderer.invoke('settings:update-mcp-server', serverId, config),
    addMCPServer: (config: any) => ipcRenderer.invoke('settings:add-mcp-server', config),
    removeMCPServer: (serverId: string) => ipcRenderer.invoke('settings:remove-mcp-server', serverId),
    // Real-time MCP event subscription
    subscribeMCPEvents: () => ipcRenderer.invoke('settings:subscribe-mcp-events'),
    onMCPStatusChange: (callback: (data: { serverId: string; status: any }) => void) => {
        const listener = (_event: any, data: { serverId: string; status: any }) => callback(data);
        ipcRenderer.on('mcp-status-changed', listener);
        return () => ipcRenderer.off('mcp-status-changed', listener); // Return cleanup function
    }
});

// Expose ipcRenderer for real-time event listening
contextBridge.exposeInMainWorld('electronAPI', {
    ipcRenderer: {
        on: (channel: string, listener: (...args: any[]) => void) => ipcRenderer.on(channel, listener),
        off: (channel: string, listener: (...args: any[]) => void) => ipcRenderer.off(channel, listener),
        removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel)
    }
});

// Type definitions for global API
declare global {
    interface Window {
        settingsAPI: {
            getConfig: () => Promise<{ success: boolean; config?: any; error?: string }>;
            updateConfig: (updates: any) => Promise<{ success: boolean; error?: string }>;
            getSchema: () => Promise<{ success: boolean; schema?: any; error?: string }>;
            getModels: (provider: string) => Promise<{ success: boolean; models?: Array<{value: string; label: string}>; error?: string }>;
            openByokWidget: () => void;
            focus: () => void;
            focusByokWidget: () => void;
            // MCP-related methods
            testMCPConnection: (serverConfig: any) => Promise<{ success: boolean; result?: any; error?: string }>;
            getMCPStatus: () => Promise<{ success: boolean; status?: any; error?: string }>;
            reloadMCP: () => Promise<{ success: boolean; error?: string }>;
            updateMCPServer: (serverId: string, config: any) => Promise<{ success: boolean; error?: string }>;
            addMCPServer: (config: any) => Promise<{ success: boolean; error?: string }>;
            removeMCPServer: (serverId: string) => Promise<{ success: boolean; error?: string }>;
            // Real-time MCP event subscription
            subscribeMCPEvents: () => Promise<{ success: boolean; error?: string }>;
            onMCPStatusChange: (callback: (data: { serverId: string; status: any }) => void) => () => void;
        };
    }
}
