/**
 * Athena Agent
 * 
 * Standalone conversational agent that uses Canvas Engine tools
 * Enhanced with modern OOP design patterns for better maintainability
 * Supports multiple LLM providers with hot configuration reloading
 */

import { Canvas } from '@/lib/types/canvas';
import { DynamicStructuredTool } from "@langchain/core/tools";
import logger from '@utils/logger';
import { createHash } from 'crypto';
import { CanvasEngine } from '../canvas/canvas-engine';
import { apiKeyManager } from "../infrastructure/config/api-key-manager";
import { DEFAULT_MODEL_NAME, ProviderConfig } from '../infrastructure/config/config';
import { ConfigurableComponent } from '../infrastructure/config/configurable-component';
import { ConfigurationManager } from "../infrastructure/config/configuration-manager";
import { LLMProviderFactory } from '../integrations/llm/providers/llm-provider-factory';
import { MCPManager } from '../integrations/mcp/mcp-manager';
import { ToolStatusCallback, ConversationUpdate, ToolStatusUpdate } from './types/tool-status';
import { WorkflowManager, LangGraphWorkflowManager } from './workflows/langgraph-workflow-manager';
import { SystemPromptBuilder, DefaultSystemPromptBuilder } from './prompts/system-prompt-builder';

// Exported types for agent status
export type AgentConnectionStatus = 'unknown' | 'connected' | 'failed' | 'no-key' | 'local' | 'disabled' | 'configured' | 'error' | 'disconnected'; // Added 'disabled', 'configured', 'error', 'disconnected' to cover all known states

export interface AgentStatusInfo {
    initialized: boolean;
    ready: boolean;
    provider: string;
    model: string;
    hasValidConfig: boolean;
    connectionStatus: AgentConnectionStatus;
    lastError?: string;
    activeTools?: string[];
    mcpServers?: string[];
}

/**
 * Dependency injection interface for Athena Agent
 */
interface AthenaAgentDependencies {
    canvasEngine?: CanvasEngine;
    llmFactory?: typeof LLMProviderFactory;
    systemPromptBuilder?: SystemPromptBuilder;
    statusCallback?: ToolStatusCallback;
    mcpManager?: MCPManager;
}

export class AthenaAgent extends ConfigurableComponent<ProviderConfig> {
    private llm: BaseChatModel | null = null;
    private workflow: any = null;
    private threadId: string = `athena-${Date.now()}`;
    private initialized = false;
    private connectionStatus: AgentConnectionStatus = 'unknown';
    private mcpEventCleanup: (() => void) | null = null;
    private lastError?: string; // Simple error tracking
    
    // Tool cache for preventing unnecessary LLM recreation
    private lastToolsHash: string | null = null;
    
    // Configuration cache to avoid redundant reloads
    private lastConfigHash: string | null = null;
    
    // Injected dependencies
    private readonly canvasEngine: CanvasEngine;
    private readonly llmFactory: typeof LLMProviderFactory;
    private readonly systemPromptBuilder: SystemPromptBuilder;
    private readonly workflowManager: WorkflowManager;
    private readonly statusCallback?: ToolStatusCallback;
    private readonly canvasType: string;
    private readonly mcpManager: MCPManager;

    constructor(canvasType: string = 'desktop', dependencies?: AthenaAgentDependencies) {
        super({
            configPath: 'provider',
            defaultConfig: {
                service: 'google' as const,
                apiKey: '',
                model: DEFAULT_MODEL_NAME,
                baseUrl: undefined,
                temperature: 0.2,
                maxTokens: 4096
            }
        });
        
        this.canvasType = canvasType;
        
        // Inject dependencies with sensible defaults for backward compatibility
        this.canvasEngine = dependencies?.canvasEngine || new CanvasEngine(canvasType);
        this.llmFactory = dependencies?.llmFactory || LLMProviderFactory;
        this.statusCallback = dependencies?.statusCallback;
        this.mcpManager = dependencies?.mcpManager || new MCPManager();
        this.systemPromptBuilder = dependencies?.systemPromptBuilder || new DefaultSystemPromptBuilder(this.mcpManager);
        this.workflowManager = new LangGraphWorkflowManager(
            this.statusCallback, 
            this.canvasEngine, 
            this.systemPromptBuilder
        );
        
        logger.info(`[Athena] Agent created with ${canvasType} canvas using enhanced architecture`);
    }

    /**
     * Initialize agent with dependency injection pattern
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            logger.warn('[Athena] Already initialized');
            return;
        }

        try {
            await this.canvasEngine.initialize();
            
            // Initialize MCP manager
            await this.mcpManager.initialize();
            
            // Set up persistent event listeners for MCP connection changes
            this.setupMCPEventListeners();
            
            await this.reloadConfiguration();
            
            // Listen for API key changes and reinitialize LLM
            apiKeyManager.onChange((provider) => {
                const currentConfig = this.getConfig();
                if (currentConfig.service === provider) {
                    logger.info(`[Athena] API key changed for ${provider}, reinitializing LLM...`);
                    this.initializeLLM().catch(error => {
                        logger.error('[Athena] Failed to reinitialize LLM after API key change:', error);
                    });
                }
            });
            
            this.initialized = true;
            logger.info('[Athena] Agent fully initialized');
        } catch (error) {
            logger.error('[Athena] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Set up persistent event listeners for MCP connection changes
     * This ensures the agent automatically refreshes tools when MCP servers connect/disconnect
     */
    private setupMCPEventListeners(): void {
        let debounceTimer: NodeJS.Timeout | null = null;
        
        const debouncedRefresh = async (serverId: string, status: { connected: boolean; toolCount?: number; error?: string }) => {
            // Clear any existing timer
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            
            // Debounce rapid connection changes (e.g., during config updates with multiple servers)
            debounceTimer = setTimeout(async () => {
                if (this.initialized) {
                    logger.info(`[Athena] MCP server ${serverId} ${status.connected ? 'connected' : 'disconnected'} (${status.toolCount || 0} tools)`);
                    
                    try {
                        await this.refreshTools();
                        logger.debug(`[Athena] Tools refreshed after ${serverId} status change`);
                    } catch (error) {
                        logger.error(`[Athena] Failed to refresh tools after MCP server ${serverId} change:`, error);
                    }
                }
                debounceTimer = null;
            }, 500);
        };
        
        // Set up the persistent listener
        this.mcpManager.onConnectionStatusChange(debouncedRefresh);
        
        // Store cleanup function
        this.mcpEventCleanup = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            this.mcpManager.offConnectionStatusChange(debouncedRefresh);
            logger.debug('[Athena] Cleaned up MCP event listeners');
        };
        
        logger.info('[Athena] Set up persistent MCP event listeners for automatic tool refresh');
    }

    /**
     * Reload configuration from configuration manager only if changed
     */
    private async reloadConfiguration(): Promise<void> {
        try {
            const configManager = ConfigurationManager.getInstance();
            const fullConfig = configManager.get();
            const providerConfig = fullConfig.provider;
            
            if (!providerConfig) {
                logger.warn('[Athena] No provider configuration found during reload');
                return;
            }
            
            // Create a hash of the current configuration
            const configHash = this.hashConfig(providerConfig);
            
            // Check if configuration has actually changed
            if (this.lastConfigHash === configHash) {
                logger.debug('[Athena] Configuration unchanged, skipping reload');
                return;
            }
            
            // Configuration has changed
            const currentConfig = this.getConfig();
            this.config = providerConfig;
            this.lastConfigHash = configHash;
            
            logger.info(`[Athena] Configuration reloaded - API Key: ${providerConfig.apiKey ? '***' + providerConfig.apiKey.slice(-4) : 'NONE'}, Model: ${providerConfig.model}`);
            await this.initializeLLM();
        } catch (error) {
            logger.error('[Athena] Failed to reload configuration:', error);
        }
    }

    /**
     * Initialize LLM with factory pattern and proper error handling
     */
    private async initializeLLM(): Promise<void> {
        try {
            const providerConfig = this.getConfig();
            if (!providerConfig || !providerConfig.service || providerConfig.service === 'disabled') {
                if (providerConfig?.service === 'disabled') {
                    logger.info('[Athena] LLM service is disabled by configuration.');
                    this.connectionStatus = 'disabled';
                    this.lastError = undefined;
                } else {
                    this.handleValidationFailure(providerConfig, ['Provider not configured']);
                }
                this.llm = null;
                this.workflow = null;
                return;
            }

            // Get the latest API key directly from the source of truth
            const apiKey = await apiKeyManager.getApiKey(providerConfig.service);
            const effectiveConfig = { ...providerConfig, apiKey: apiKey || '' };

            logger.debug(`[Athena] Retrieved API key for validation. Has key: ${!!apiKey}. Key ends with: ${apiKey ? '...' + apiKey.slice(-4) : 'N/A'}`);
            logger.info(`[Athena] Initializing LLM: ${effectiveConfig.service}/${effectiveConfig.model}`);

            // Validate provider configuration
            const errors = LLMProviderFactory.validateProvider(effectiveConfig);
            if (this.shouldFailValidation(effectiveConfig, errors)) {
                this.handleValidationFailure(effectiveConfig, errors);
                return;
            }

            // Create LLM instance
            this.llm = await this.llmFactory.createLLM({
                provider: effectiveConfig,
                tools: [] // Tools will be added in _rebuildWorkflow
            });
            this.connectionStatus = 'connected';
            this.lastError = undefined;
            logger.info(`[Athena] LLM initialized successfully: ${effectiveConfig.service}`);

            // Rebuild the workflow with the new LLM
            await this._rebuildWorkflow();

        } catch (error: any) {
            const providerConfig = this.getConfig();
            const errorMessage = error.message || 'Unknown error';
            logger.error(`[Athena] Failed to initialize LLM: ${errorMessage}`);
            this.llm = null;
            this.workflow = null;
            this.connectionStatus = 'failed';
            this.lastError = errorMessage;
            if (this.statusCallback) {
                const statusUpdate: ToolStatusUpdate = {
                    status: 'error',
                    toolName: 'LLMInitialization',
                    timestamp: new Date().toISOString(),
                    metadata: { error: errorMessage, provider: providerConfig?.service, model: providerConfig?.model }
                };
                this.statusCallback(statusUpdate);
            }
        }
    }

    private shouldFailValidation(providerConfig: ProviderConfig, errors: string[]): boolean {
        // Fail if there are any errors and the provider is not 'disabled'
        // Allows 'disabled' provider to proceed without full validation for UI/testing purposes
        return errors.length > 0 && providerConfig.service !== 'disabled';
    }

    private handleValidationFailure(providerConfig: ProviderConfig | undefined, errors: string[]): void {
        const service = providerConfig?.service || 'unknown';
        const errorMsg = `Provider validation failed for ${service}: ${errors.join(', ')}`;
        logger.error(`[Athena] ${errorMsg}`);
        this.llm = null;
        this.workflow = null;
        this.connectionStatus = 'failed';
        this.lastError = errorMsg;
    }

    /**
     * Configuration change handler with proper error handling
     */
    protected async onConfigurationChange(newConfig: ProviderConfig, previousConfig: ProviderConfig): Promise<void> {
        logger.info(`[Athena] onConfigurationChange triggered. Old: ${previousConfig.service}/${previousConfig.model}, New: ${newConfig.service}/${newConfig.model}.`);
        
        try {
            // Delegate to reloadConfiguration, which includes a hash check and further logging.
            await this.reloadConfiguration(); 
        } catch (error) {
            logger.error(`[Athena] Error during onConfigurationChange (calling reloadConfiguration) for ${newConfig.service}/${newConfig.model}:`, error);
        }
    }

    /**
     * Get additional non-canvas tools including MCP tools
     */
    private getAdditionalTools(): DynamicStructuredTool[] {
        const additionalTools: DynamicStructuredTool[] = [];
        
        // Add MCP tools if available
        try {
            const mcpTools = this.mcpManager.getTools();
            additionalTools.push(...mcpTools);
            logger.info(`[Athena] Added ${mcpTools.length} MCP tools from ${this.mcpManager.getConnectedServers().length} servers`);
        } catch (error) {
            logger.warn('[Athena] Failed to get MCP tools:', error);
        }
        
        // Add other tools here like web search, file operations, etc.
        
        return additionalTools;
    }

    /**
     * Process user input. This method will attempt to stream the response.
     * If streaming events are available, onChunk will be called for each chunk.
     * If streaming events fail or are not available, the workflowManager.streamMessage
     * will fall back to a regular invocation, and the full response will be
     * delivered as a single call to onChunk.
     * Tool calls and other updates are sent via the onUpdate callback.
     */
    async invoke(
        userInput: string, 
        onChunk: (chunk: string) => void, // Made non-optional as streamMessage requires it
        onUpdate?: (update: ConversationUpdate) => void
    ): Promise<string> {
        logger.info(`[Athena] Processing: "${userInput}"`);
        
        if (!this.initialized || !this.workflow) {
            // If onUpdate is available, send an error update to the UI
            if (onUpdate) {
                onUpdate({
                    type: 'agent-stream-error',
                    content: this.getNotReadyMessage(),
                    timestamp: new Date().toISOString()
                });
            }
            return this.getNotReadyMessage();
        }

        try {
            const config = { configurable: { thread_id: this.threadId } };
            
            // Always use streamMessage. It handles its own fallback to non-streaming if necessary.
            const result = await this.workflowManager.streamMessage(
                this.workflow, 
                userInput, 
                config, 
                onChunk, 
                onUpdate
            );
            this.lastError = undefined; // Clear error on success
            return result;
        } catch (error: any) {
            this.lastError = error.message;
            const errorMessage = `❌ I encountered an error: ${error.message}. Please try again.`;
            logger.error(`[Athena] Error processing input:`, error);
            
            // Send error to UI via onUpdate if available
            if (onUpdate) {
                onUpdate({
                    type: 'agent-stream-error',
                    content: errorMessage,
                    timestamp: new Date().toISOString()
                });
            }
            return errorMessage;
        }
    }

    private getNotReadyMessage(): string {
        const providerInfo = this.getProviderInfo();
        if (!providerInfo.ready && providerInfo.lastError?.includes('API key')) {
            return "⚠️ Your AI provider API key is missing or invalid. Please check your settings.";
        }
        return "⚠️ Athena is not ready. Please wait a moment or check your configuration.";
    }

    /**
     * Refresh agent tools (useful when MCP servers change)
     */
    async refreshTools(): Promise<void> {
        if (this.initialized) {
            logger.debug('[Athena] Refreshing agent tools...');
            try {
                // Rebuild workflow with updated tools
                await this._rebuildWorkflow();
                logger.debug('[Athena] Agent tools refreshed successfully');
            } catch (error) {
                logger.error('[Athena] Failed to refresh agent tools:', error);
            }
        }
    }

    /**
     * Rebuilds the agent's workflow with the current LLM and tools.
     * This should be called after the LLM is initialized or when tools change.
     */
    private async _rebuildWorkflow(): Promise<void> {
        if (!this.llm) {
            logger.warn('[Athena] Cannot rebuild workflow without an LLM instance.');
            this.workflow = null;
            return;
        }

        try {
            logger.debug('[Athena] Rebuilding workflow...');
            const providerConfig = this.getConfig();

            // Get all tools
            const canvasTools = this.canvasEngine.getTools();
            const allTools = [...canvasTools, ...this.getAdditionalTools()];

            // Check if tools have changed to avoid unnecessary recreation
            const toolsHash = this.hashTools(allTools, providerConfig);
            if (this.workflow && this.lastToolsHash === toolsHash) {
                logger.debug('[Athena] Tools unchanged, reusing existing workflow.');
                return;
            }
            
            logger.info(`[Athena] Rebuilding workflow with ${allTools.length} tools.`);

            // Create workflow
            this.workflow = this.workflowManager.createWorkflow(this.llm, allTools, this.statusCallback);

            // Cache tools hash
            this.lastToolsHash = toolsHash;

            logger.debug('[Athena] Workflow rebuilt successfully.');
        } catch (error) {
            logger.error('[Athena] Failed to rebuild workflow:', error);
            this.workflow = null; // Ensure workflow is null on failure
        }
    }
    
    /**
     * Get canvas state for external inspection
     */
    async getCanvasState(): Promise<Canvas> {
        return this.canvasEngine.getCanvas();
    }
    
    /**
     * Monitor canvas changes
     */
    monitorCanvas(callback: (canvas: Canvas) => void): void {
        this.canvasEngine.monitorChanges(callback);
    }
    
    /**
     * Check if agent has valid configuration (async to properly check API keys)
     */
    async hasValidConfigurationAsync(): Promise<boolean> {
        const providerConfig = this.getConfig();
        const errors = await this.llmFactory.validateProviderAsync(providerConfig);
        
        // Ollama doesn't require API key
        if (providerConfig.service === 'ollama') {
            return !errors.some(e => e.includes('Model name'));
        }
        
        return errors.length === 0;
    }

    /**
     * Check if agent has valid configuration (sync version for backward compatibility)
     * Note: This may not reflect actual API key availability
     */
    hasValidConfiguration(): boolean {
        const providerConfig = this.getConfig();
        const errors = this.llmFactory.validateProvider(providerConfig);
        
        // Ollama doesn't require API key
        if (providerConfig.service === 'ollama') {
            return !errors.some(e => e.includes('Model name'));
        }
        
        return errors.length === 0;
    }

    // Public interface methods
    isReady(): boolean { return this.initialized && this.workflow !== null && this.connectionStatus === 'connected'; }
    getConnectionStatus() { return this.connectionStatus; }
    clearHistory(): void { this.threadId = `athena-${Date.now()}`; }
    getCanvasType(): string { return this.canvasType; }
    
    /**
     * Get current provider info including MCP status and last error
     */
    getProviderInfo(): { service: string; model: string; ready: boolean; mcpServers?: string[]; lastError?: string } {
        const config = this.getConfig();
        return {
            service: config.service,
            model: config.model,
            ready: this.isReady(),
            mcpServers: this.mcpManager.getConnectedServers(),
            lastError: this.lastError
        };
    }
    
    /**
     * Get MCP connection status
     */
    getMCPStatus(): { enabled: boolean; servers: { [serverId: string]: { connected: boolean; lastConnected?: Date; attempts: number } } } {
        try {
            const connectionStatus = this.mcpManager.getConnectionStatus();
            const fullConfig = ConfigurationManager.getInstance().get();
            const mcpEnabled = fullConfig?.integrations?.mcp?.enabled || false;
            return {
                enabled: mcpEnabled,
                servers: connectionStatus
            };
        } catch (error) {
            logger.error('[Athena] Failed to get MCP status:', error);
            return { enabled: false, servers: {} };
        }
    }

    /**
     * Get tool count by MCP server for UI display
     */
    getMCPToolCounts(): { [serverId: string]: number } {
        try {
            const tools = this.mcpManager.getTools();
            const toolsByServer: { [serverId: string]: number } = {};
            
            tools.forEach((tool) => {
                const serverId = (tool as any).metadata?.serverId || (tool as any).serverId;
                
                if (serverId) {
                    toolsByServer[serverId] = (toolsByServer[serverId] || 0) + 1;
                }
            });
            
            return toolsByServer;
        } catch (error) {
            logger.warn('[Athena] Failed to get MCP tool counts:', error);
            return {};
        }
    }
    
    async destroy(): Promise<void> {
        if (this.mcpEventCleanup) {
            this.mcpEventCleanup();
            this.mcpEventCleanup = null;
        }
        
        // Stop metrics reporting if using LangGraphWorkflowManager
        if (this.workflowManager && typeof (this.workflowManager as any).stopMetricsReporting === 'function') {
            (this.workflowManager as any).stopMetricsReporting();
        }
        
        super.destroy();
        await this.canvasEngine.destroy();
        await this.mcpManager.destroy();
        this.llm = null;
        this.workflow = null;
        this.initialized = false;
        logger.info('[Athena] Agent destroyed');
    }

    /**
     * Get performance metrics snapshot for monitoring and debugging
     */
    getPerformanceMetrics(): any {
        return this.workflowManager.getMetricsSnapshot();
    }

    /**
     * Build ultra-efficient system prompt using consolidated approach
     * Now uses centralized parsing to prevent duplication
     */
    async buildEfficientSystemPrompt(canvas: Canvas, providerConfig: ProviderConfig): Promise<string> {
        return this.systemPromptBuilder.buildPrompt(canvas, providerConfig, this.threadId);
    }

    private hashTools(tools: DynamicStructuredTool[], providerConfig: ProviderConfig): string {
        try {
            const toolNames = tools.map(t => t.name).sort().join(',');
            const configString = `${providerConfig.service}-${providerConfig.model}`;
            return createHash('sha256').update(toolNames + configString).digest('hex');
        } catch (error) {
            logger.warn('[Athena] Failed to hash tools:', error);
            return `error-${Date.now()}`;
        }
    }
    
    private hashConfig(config: ProviderConfig): string {
        // Create lightweight hash of config for change detection
        const configKey = `${config.service}:${config.model}:${config.apiKey || ''}:${config.baseUrl || ''}:${config.temperature}:${config.maxTokens}`;
        
        // Simple fast hash function
        let hash = 0;
        for (let i = 0; i < configKey.length; i++) {
            const char = configKey.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString(36);
    }
}

