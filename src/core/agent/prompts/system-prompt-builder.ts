// System prompt builder for AthenaAgent

import { Canvas } from '@/lib/types/canvas';
import { ProviderConfig } from '../infrastructure/config/config';
import { MCPManager } from '../integrations/mcp/mcp-manager';
import { getCanvasStateParser } from './canvas-state-parser';
import { buildCoreSystemPrompt, buildMCPSummary } from './core-system';
import { buildPlatformComponentsDescription } from './layout-calculations';
import { buildUIComponentsSummary } from './ui-components';

export interface SystemPromptBuilder {
    buildPrompt(canvas: Canvas, providerConfig: ProviderConfig, threadId?: string): Promise<string>;
}

export class DefaultSystemPromptBuilder implements SystemPromptBuilder {
    constructor(private mcpManager: MCPManager) {}

    async buildPrompt(canvas: Canvas, providerConfig: ProviderConfig, threadId?: string): Promise<string> {
        const parser = getCanvasStateParser();
        const parsedState = await parser.getParsedState(canvas);

        const mcpTools = this.mcpManager.getTools();
        const mcpServers = this.mcpManager.getConnectedServers();

        return buildCoreSystemPrompt({
            userWindowCount: parsedState.windowCount,
            screenWidth: parsedState.workArea.width,
            screenHeight: parsedState.workArea.height,
            defaultX: parsedState.layoutCalculations.defaultX,
            defaultY: parsedState.layoutCalculations.defaultY,
            maxUsableWidth: parsedState.layoutCalculations.maxUsableWidth,
            defaultHeight: parsedState.layoutCalculations.defaultHeight,
            windowGap: parsedState.layoutCalculations.windowGap,
            platformComponents: buildPlatformComponentsDescription(parsedState.workArea, parsedState.layoutCalculations),
            userWindows: parsedState.userWindowsDescription,
            mcpSummary: buildMCPSummary(mcpTools, mcpServers),
            uiComponentsSummary: buildUIComponentsSummary()
        });
    }
}

